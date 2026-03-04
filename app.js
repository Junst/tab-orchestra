/* ============================================================
   Tab Orchestra — app.js
   Multi-tab music decomposition art using BroadcastChannel,
   IndexedDB, Web Audio API, and Canvas 2D.
   ============================================================ */

(() => {
  'use strict';

  // ── Constants ──────────────────────────────────────────────
  const STEMS = ['vocals', 'drums', 'bass', 'other'];
  const STEM_COLORS = {
    vocals: '#00E5FF',
    drums:  '#FF4444',
    bass:   '#AA44FF',
    other:  '#44FF88',
  };
  const STEM_LABELS = {
    vocals: 'Vocals',
    drums:  'Drums',
    bass:   'Bass',
    other:  'Other',
  };
  const DB_NAME = 'tab-orchestra';
  const DB_STORE = 'stems';
  const DB_VERSION = 1;
  const HF_SPACE_BASE = 'https://solbon1212-tab-orchestra-demucs.hf.space';
  const CHANNEL_NAME = 'tab-orchestra';

  // ── State ──────────────────────────────────────────────────
  const tabId = crypto.randomUUID();
  let isCoordinator = false;
  let assignedStem = null;       // 'vocals' | 'drums' | 'bass' | 'other'
  let audioCtx = null;
  let sourceNode = null;
  let analyser = null;
  let audioBuffer = null;
  let isPlaying = false;
  let playStartTime = 0;         // audioCtx.currentTime when play began
  let playOffset = 0;            // offset in seconds into the buffer
  let activeTabs = new Map();    // tabId → stem
  let channel = null;
  let animationId = null;
  let particles = [];

  // ── DOM refs ───────────────────────────────────────────────
  const $upload     = document.getElementById('upload-screen');
  const $processing = document.getElementById('processing-screen');
  const $waiting    = document.getElementById('waiting-screen');
  const $full       = document.getElementById('full-screen');
  const $visualizer = document.getElementById('visualizer');
  const $canvas     = document.getElementById('canvas');
  const ctx2d       = $canvas.getContext('2d');
  const $dropZone   = document.getElementById('drop-zone');
  const $fileInput  = document.getElementById('file-input');
  const $demoBtn    = document.getElementById('demo-btn');
  const $statusText = document.getElementById('status-text');
  const $progressFill = document.getElementById('progress-fill');
  const $instrLabel = document.getElementById('instrument-label');
  const $tabCount   = document.getElementById('tab-count');
  const $playPause  = document.getElementById('play-pause-btn');
  const $timeDisplay = document.getElementById('time-display');

  // ── IndexedDB helpers ──────────────────────────────────────
  function openDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(DB_STORE)) {
          db.createObjectStore(DB_STORE);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function dbPut(key, value) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(DB_STORE, 'readwrite');
      tx.objectStore(DB_STORE).put(value, key);
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => { db.close(); reject(tx.error); };
    });
  }

  async function dbGet(key) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(DB_STORE, 'readonly');
      const req = tx.objectStore(DB_STORE).get(key);
      req.onsuccess = () => { db.close(); resolve(req.result); };
      req.onerror = () => { db.close(); reject(req.error); };
    });
  }

  async function dbHasStems() {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(DB_STORE, 'readonly');
      const req = tx.objectStore(DB_STORE).getAllKeys();
      req.onsuccess = () => {
        db.close();
        const keys = req.result;
        resolve(STEMS.every(s => keys.includes(s)));
      };
      req.onerror = () => { db.close(); reject(req.error); };
    });
  }

  // ── BroadcastChannel ───────────────────────────────────────
  function initChannel() {
    channel = new BroadcastChannel(CHANNEL_NAME);
    channel.onmessage = handleMessage;
  }

  function broadcast(type, data = {}) {
    channel.postMessage({ type, from: tabId, ...data });
  }

  function handleMessage(e) {
    const msg = e.data;
    if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') return;
    if (msg.from === tabId) return; // ignore own messages
    if (msg.type === 'assign' && !STEMS.includes(msg.stem)) return;

    switch (msg.type) {
      case 'join':
        handleJoin(msg);
        break;
      case 'assign':
        if (msg.target === tabId) handleAssign(msg);
        break;
      case 'stems-ready':
        handleStemsReady(msg);
        break;
      case 'play':
        handleRemotePlay(msg);
        break;
      case 'pause':
        handleRemotePause(msg);
        break;
      case 'seek':
        handleRemoteSeek(msg);
        break;
      case 'leave':
        handleLeave(msg);
        break;
      case 'roster':
        handleRoster(msg);
        break;
      case 'roster-request':
        if (isCoordinator) sendRoster();
        break;
      case 'full':
        if (msg.target === tabId) showFull();
        break;
    }
  }

  // ── Coordinator logic ──────────────────────────────────────
  function getAssignedStems() {
    return new Set(activeTabs.values());
  }

  function findFreeStem() {
    const assigned = getAssignedStems();
    return STEMS.find(s => !assigned.has(s)) || null;
  }

  function handleJoin(msg) {
    if (!isCoordinator) return;
    const stem = findFreeStem();
    if (stem) {
      activeTabs.set(msg.from, stem);
      broadcast('assign', { target: msg.from, stem });
      sendRoster();
    } else {
      broadcast('full', { target: msg.from });
    }
  }

  function handleLeave(msg) {
    activeTabs.delete(msg.from);
    if (isCoordinator) {
      sendRoster();
    }
    updateTabCountDisplay();

    // If coordinator left, elect new coordinator (lowest tabId)
    if (msg.wasCoordinator) {
      electNewCoordinator();
    }
  }

  function electNewCoordinator() {
    const allIds = [...activeTabs.keys()].sort();
    if (allIds.length > 0 && allIds[0] === tabId) {
      isCoordinator = true;
      sendRoster();
    }
  }

  function sendRoster() {
    const roster = Object.fromEntries(activeTabs);
    broadcast('roster', { roster, playing: isPlaying, offset: getCurrentOffset() });
  }

  function handleRoster(msg) {
    activeTabs = new Map(Object.entries(msg.roster));
    updateTabCountDisplay();
  }

  // ── Role assignment ────────────────────────────────────────
  function handleAssign(msg) {
    assignedStem = msg.stem;
    onStemAssigned();
  }

  async function onStemAssigned() {
    document.body.className = `stem-${assignedStem}`;
    $instrLabel.textContent = STEM_LABELS[assignedStem];
    $instrLabel.style.color = STEM_COLORS[assignedStem];
    updateTabCountDisplay();

    // Try loading stem from IndexedDB
    const hasStems = await dbHasStems();
    if (hasStems) {
      await loadAndPlayStem();
    } else {
      show($waiting);
    }
  }

  function handleStemsReady() {
    if (assignedStem) {
      hide($waiting);
      loadAndPlayStem();
    }
  }

  // ── Audio loading & playback ───────────────────────────────
  async function loadAndPlayStem() {
    if (!audioCtx) {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }

    const arrayBuf = await dbGet(assignedStem);
    if (!arrayBuf) return;

    audioBuffer = await audioCtx.decodeAudioData(arrayBuf.slice(0));

    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0.8;
    analyser.connect(audioCtx.destination);

    show($visualizer);
    resizeCanvas();
    startVisualizer();

    // Auto-play if other tabs are playing
    if (isPlaying) {
      startPlayback(playOffset);
    }

    updateTimeDisplay();
  }

  function startPlayback(offset = 0) {
    if (!audioBuffer || !audioCtx) return;

    // Stop existing source
    if (sourceNode) {
      try { sourceNode.stop(); } catch (_) {}
    }

    sourceNode = audioCtx.createBufferSource();
    sourceNode.buffer = audioBuffer;
    sourceNode.connect(analyser);
    sourceNode.onended = onPlaybackEnded;

    const clampedOffset = Math.min(offset, audioBuffer.duration);
    sourceNode.start(0, clampedOffset);
    playStartTime = audioCtx.currentTime;
    playOffset = clampedOffset;
    isPlaying = true;
    $playPause.textContent = '\u23F8';
  }

  function stopPlayback() {
    if (sourceNode) {
      try { sourceNode.stop(); } catch (_) {}
      sourceNode = null;
    }
    playOffset = getCurrentOffset();
    isPlaying = false;
    $playPause.textContent = '\u25B6';
  }

  function getCurrentOffset() {
    if (!isPlaying || !audioCtx) return playOffset;
    const elapsed = audioCtx.currentTime - playStartTime;
    const total = audioBuffer ? audioBuffer.duration : 0;
    return Math.min(playOffset + elapsed, total);
  }

  function onPlaybackEnded() {
    if (isPlaying && audioBuffer) {
      const elapsed = audioCtx.currentTime - playStartTime;
      if (playOffset + elapsed >= audioBuffer.duration - 0.1) {
        // Song ended
        isPlaying = false;
        playOffset = 0;
        $playPause.textContent = '\u25B6';
        if (isCoordinator) {
          broadcast('pause', { offset: 0 });
        }
      }
    }
  }

  // ── Sync ───────────────────────────────────────────────────
  function handleRemotePlay(msg) {
    playOffset = msg.offset || 0;
    startPlayback(playOffset);
  }

  function handleRemotePause(msg) {
    playOffset = msg.offset || 0;
    stopPlayback();
    playOffset = msg.offset || 0;
  }

  function handleRemoteSeek(msg) {
    playOffset = msg.offset || 0;
    if (isPlaying) {
      startPlayback(playOffset);
    }
  }

  // ── Play/Pause button ─────────────────────────────────────
  $playPause.addEventListener('click', () => {
    if (!audioBuffer) return;
    if (isPlaying) {
      const offset = getCurrentOffset();
      stopPlayback();
      broadcast('pause', { offset });
    } else {
      startPlayback(playOffset);
      broadcast('play', { offset: playOffset });
    }
  });

  // ── File upload / Demo ─────────────────────────────────────
  $dropZone.addEventListener('click', () => $fileInput.click());
  $dropZone.addEventListener('dragover', e => {
    e.preventDefault();
    $dropZone.classList.add('dragover');
  });
  $dropZone.addEventListener('dragleave', () => {
    $dropZone.classList.remove('dragover');
  });
  $dropZone.addEventListener('drop', e => {
    e.preventDefault();
    $dropZone.classList.remove('dragover');
    if (e.dataTransfer.files.length > 0) {
      handleFileUpload(e.dataTransfer.files[0]);
    }
  });
  $fileInput.addEventListener('change', () => {
    if ($fileInput.files.length > 0) {
      handleFileUpload($fileInput.files[0]);
    }
  });

  $demoBtn.addEventListener('click', () => loadDemo());

  async function handleFileUpload(file) {
    const MAX_SIZE = 20 * 1024 * 1024; // 20 MB
    if (file.size > MAX_SIZE) {
      $statusText.textContent = 'Error: File too large (max 20 MB).';
      show($processing);
      return;
    }
    show($processing);
    $statusText.textContent = 'Uploading & separating stems...';
    $progressFill.style.width = '10%';

    try {
      const stems = await separateWithHFSpace(file);
      $progressFill.style.width = '80%';
      $statusText.textContent = 'Storing stems...';

      for (const [stemName, arrayBuffer] of Object.entries(stems)) {
        await dbPut(stemName, arrayBuffer);
      }
      $progressFill.style.width = '100%';
      $statusText.textContent = 'Ready!';

      broadcast('stems-ready', {});
      await loadAndPlayStem();
    } catch (err) {
      $statusText.textContent = `Error: ${err.message}`;
      console.error(err);
    }
  }

  async function separateWithHFSpace(file) {
    // Gradio 5.x SSE-based API

    // Step 0: Wake up Space if sleeping
    $statusText.textContent = 'Connecting to server...';
    $progressFill.style.width = '10%';
    try {
      const wake = await fetch(`${HF_SPACE_BASE}/gradio_api/config`, { method: 'GET' });
      if (!wake.ok) throw new Error(`Server not ready (${wake.status})`);
    } catch (e) {
      throw new Error(`Cannot reach server: ${e.message}`);
    }

    // Step 1: Upload file
    $statusText.textContent = 'Uploading audio...';
    $progressFill.style.width = '20%';

    const formData = new FormData();
    formData.append('files', file);
    let uploadRes;
    try {
      uploadRes = await fetch(`${HF_SPACE_BASE}/gradio_api/upload`, {
        method: 'POST',
        body: formData,
      });
    } catch (e) {
      throw new Error(`Upload network error: ${e.message}`);
    }
    if (!uploadRes.ok) {
      const body = await uploadRes.text().catch(() => '');
      throw new Error(`Upload failed (${uploadRes.status}): ${body.slice(0, 200)}`);
    }
    const uploadedPaths = await uploadRes.json();

    // Step 2: Call the function (SSE)
    $statusText.textContent = 'Separating stems (this may take ~2 min)...';
    $progressFill.style.width = '30%';

    const callRes = await fetch(`${HF_SPACE_BASE}/gradio_api/call/separate_stems`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        data: [{ path: uploadedPaths[0], orig_name: file.name, mime_type: file.type }],
      }),
    });
    if (!callRes.ok) {
      const body = await callRes.text().catch(() => '');
      throw new Error(`Separation request failed (${callRes.status}): ${body.slice(0, 200)}`);
    }
    const { event_id } = await callRes.json();

    // Step 3: Listen for result via SSE
    const resultData = await new Promise((resolve, reject) => {
      const es = new EventSource(`${HF_SPACE_BASE}/gradio_api/call/separate_stems/${event_id}`);
      es.addEventListener('complete', (ev) => {
        try {
          const parsed = JSON.parse(ev.data);
          es.close();
          resolve(parsed);
        } catch (_) {
          es.close();
          reject(new Error('Failed to parse result'));
        }
      });
      es.addEventListener('error', (ev) => {
        es.close();
        // Try to extract error info
        if (ev.data) {
          reject(new Error(`Separation error: ${ev.data.slice(0, 200)}`));
        } else {
          reject(new Error('Separation stream disconnected'));
        }
      });
      es.onerror = () => {
        es.close();
        reject(new Error('Separation connection lost'));
      };
      // Timeout after 5 minutes
      setTimeout(() => { es.close(); reject(new Error('Separation timed out (5 min)')); }, 300000);
    });

    $progressFill.style.width = '60%';
    $statusText.textContent = 'Downloading stems...';

    // Step 4: Download each stem file
    const stems = {};
    const stemNames = ['vocals', 'drums', 'bass', 'other'];
    for (let i = 0; i < 4; i++) {
      const stemData = resultData[i];
      const filePath = stemData?.path || stemData?.url || stemData;
      let url;
      if (typeof filePath === 'string' && filePath.startsWith('http')) {
        url = filePath;
      } else {
        url = `${HF_SPACE_BASE}/gradio_api/file=${filePath}`;
      }
      const res = await fetch(url);
      if (!res.ok) throw new Error(`Failed to download ${stemNames[i]} (${res.status})`);
      stems[stemNames[i]] = await res.arrayBuffer();
      $progressFill.style.width = `${60 + (i + 1) * 8}%`;
    }

    return stems;
  }

  async function loadDemo() {
    show($processing);
    $statusText.textContent = 'Loading demo stems...';
    $progressFill.style.width = '10%';

    try {
      for (let i = 0; i < STEMS.length; i++) {
        const stem = STEMS[i];
        const res = await fetch(`demo/${stem}.wav`);
        if (!res.ok) throw new Error(`demo/${stem}.wav not found`);
        const arrayBuffer = await res.arrayBuffer();
        await dbPut(stem, arrayBuffer);
        $progressFill.style.width = `${25 + (i + 1) * 18}%`;
      }

      $progressFill.style.width = '100%';
      $statusText.textContent = 'Ready!';
      broadcast('stems-ready', {});
      await loadAndPlayStem();
    } catch (err) {
      $statusText.textContent = `Error: ${err.message}`;
      console.error(err);
    }
  }

  // ── Canvas / Visualizer ────────────────────────────────────
  function resizeCanvas() {
    $canvas.width = window.innerWidth * devicePixelRatio;
    $canvas.height = window.innerHeight * devicePixelRatio;
    ctx2d.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
  }
  window.addEventListener('resize', resizeCanvas);

  function startVisualizer() {
    if (animationId) cancelAnimationFrame(animationId);
    draw();
  }

  function draw() {
    animationId = requestAnimationFrame(draw);

    const W = window.innerWidth;
    const H = window.innerHeight;
    const color = STEM_COLORS[assignedStem] || '#ffffff';

    // Clear
    ctx2d.fillStyle = 'rgba(10, 10, 15, 0.15)';
    ctx2d.fillRect(0, 0, W, H);

    if (!analyser) return;

    // Frequency data for waveform
    const freqData = new Uint8Array(analyser.frequencyBinCount);
    analyser.getByteFrequencyData(freqData);

    // Time domain data for amplitude
    const timeData = new Uint8Array(analyser.fftSize);
    analyser.getByteTimeDomainData(timeData);

    // Average amplitude (0–1)
    let sum = 0;
    for (let i = 0; i < timeData.length; i++) {
      const v = (timeData[i] - 128) / 128;
      sum += v * v;
    }
    const rms = Math.sqrt(sum / timeData.length);

    // ── Draw waveform (bottom half) ──
    const barCount = 128;
    const barWidth = W / barCount;
    const step = Math.floor(freqData.length / barCount);

    ctx2d.save();
    for (let i = 0; i < barCount; i++) {
      const val = freqData[i * step] / 255;
      const barH = val * H * 0.4;

      const alpha = 0.4 + val * 0.6;
      ctx2d.fillStyle = hexToRgba(color, alpha);
      ctx2d.fillRect(
        i * barWidth,
        H - barH,
        barWidth - 1,
        barH
      );
    }
    ctx2d.restore();

    // ── Draw waveform line (middle) ──
    ctx2d.beginPath();
    ctx2d.strokeStyle = hexToRgba(color, 0.6);
    ctx2d.lineWidth = 2;
    const sliceWidth = W / timeData.length;
    let x = 0;
    for (let i = 0; i < timeData.length; i++) {
      const v = timeData[i] / 128.0;
      const y = (v * H) / 2;
      if (i === 0) ctx2d.moveTo(x, y);
      else ctx2d.lineTo(x, y);
      x += sliceWidth;
    }
    ctx2d.stroke();

    // ── Particles ──
    spawnParticles(rms, color, W, H);
    updateAndDrawParticles(W, H);

    // Update time
    updateTimeDisplay();
  }

  // ── Particles system ──
  function spawnParticles(rms, color, W, H) {
    const spawnCount = Math.floor(rms * 12);
    for (let i = 0; i < spawnCount; i++) {
      particles.push({
        x: Math.random() * W,
        y: H * 0.3 + Math.random() * H * 0.4,
        vx: (Math.random() - 0.5) * 2,
        vy: -1 - Math.random() * 3 * rms,
        r: 2 + Math.random() * 4 * rms,
        alpha: 0.6 + Math.random() * 0.4,
        color: color,
        life: 1.0,
        decay: 0.005 + Math.random() * 0.015,
      });
    }

    // Cap particle count
    if (particles.length > 500) {
      particles = particles.slice(-500);
    }
  }

  function updateAndDrawParticles(W, H) {
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      p.x += p.vx;
      p.y += p.vy;
      p.life -= p.decay;
      p.alpha = p.life * 0.8;

      if (p.life <= 0 || p.y < -10 || p.x < -10 || p.x > W + 10) {
        particles.splice(i, 1);
        continue;
      }

      ctx2d.beginPath();
      ctx2d.arc(p.x, p.y, p.r * p.life, 0, Math.PI * 2);
      ctx2d.fillStyle = hexToRgba(p.color, p.alpha);
      ctx2d.fill();
    }
  }

  // ── UI helpers ──────────────────────────────────────────────
  function show(el) {
    [$upload, $processing, $waiting, $full, $visualizer].forEach(e => e.classList.add('hidden'));
    el.classList.remove('hidden');
  }

  function hide(el) {
    el.classList.add('hidden');
  }

  function showFull() {
    show($full);
  }

  function updateTabCountDisplay() {
    const count = activeTabs.size;
    $tabCount.textContent = `${count}/4 instruments playing`;
  }

  function updateTimeDisplay() {
    if (!audioBuffer) return;
    const current = getCurrentOffset();
    const total = audioBuffer.duration;
    $timeDisplay.textContent = `${fmtTime(current)} / ${fmtTime(total)}`;
  }

  function fmtTime(sec) {
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
  }

  function hexToRgba(hex, alpha) {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `rgba(${r},${g},${b},${alpha})`;
  }

  // ── Tab lifecycle ──────────────────────────────────────────
  async function init() {
    initChannel();

    // Register self with coordinator
    activeTabs.set(tabId, null);

    // Check if stems already exist (page reload scenario)
    const hasStems = await dbHasStems();

    // Announce join and wait for assignment
    broadcast('join', {});

    // Wait a bit for coordinator response
    await sleep(300);

    // If no one assigned us, we're the first tab → become coordinator
    if (!assignedStem) {
      const hasOtherTabs = activeTabs.size > 1;
      if (!hasOtherTabs) {
        becomeCoordinator(hasStems);
      } else {
        // Ask again
        broadcast('roster-request', {});
        await sleep(500);
        if (!assignedStem) {
          becomeCoordinator(hasStems);
        }
      }
    }
  }

  async function becomeCoordinator(hasStems) {
    isCoordinator = true;
    assignedStem = STEMS[0]; // Coordinator gets vocals
    activeTabs.set(tabId, assignedStem);
    sendRoster();

    document.body.className = `stem-${assignedStem}`;
    $instrLabel.textContent = STEM_LABELS[assignedStem];
    $instrLabel.style.color = STEM_COLORS[assignedStem];
    updateTabCountDisplay();

    if (hasStems) {
      // Stems already in IndexedDB, go straight to visualizer
      await loadAndPlayStem();
    } else {
      // Show upload UI
      show($upload);
    }
  }

  // ── Cleanup on tab close ───────────────────────────────────
  window.addEventListener('beforeunload', () => {
    broadcast('leave', { wasCoordinator: isCoordinator });
    activeTabs.delete(tabId);
    if (isCoordinator) {
      sendRoster();
    }
  });

  // ── Utilities ──────────────────────────────────────────────
  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // ── Start ──────────────────────────────────────────────────
  init();
})();
