/**
 * The page Darsly's recorder runs in headless Chrome.
 *
 * It joins the class the way a student's browser does — one receive-only
 * WebRTC connection to Cloudflare's SFU — except that every signalling step
 * goes through functions the recorder exposes from Node (`__cf`, `__state`),
 * so the provider secret never enters the page. What it receives is drawn on
 * one canvas and recorded with the mixed audio:
 *
 *   screen shared  → the screen, the teacher's camera in a corner
 *   no screen      → the teacher's camera
 *   students speaking with a camera → small tiles along the bottom
 *
 * Chunks of WebM go back to Node every few seconds (`__chunk`), which writes
 * them to disk as they arrive — a recorder that dies loses seconds, not the
 * lesson. Deliberately dependency-free: this string is the whole page.
 */
export const RECORDER_PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>Darsly recorder</title></head>
<body style="margin:0;background:#000">
<canvas id="c" width="1280" height="720"></canvas>
<script>
(() => {
  const W = 1280, H = 720, FPS = 15, CHUNK_MS = 5000;
  const cv = document.getElementById('c');
  const g = cv.getContext('2d');
  const pulled = new Map(); // trackId -> { mid, kind, role, userId, el }
  const byMid = new Map();
  let pc, rec, ac, dest, stopping = false;

  const log = (m) => window.__log && window.__log(String(m));

  function attach(trackId, p, track) {
    if (p.el) return;
    if (track.kind === 'video') {
      const v = document.createElement('video');
      v.muted = true; v.autoplay = true; v.playsInline = true;
      v.srcObject = new MediaStream([track]);
      v.play().catch(() => {});
      p.el = v;
    } else {
      // Chrome only feeds a remote track into Web Audio while it is also
      // attached to a media element.
      const a = document.createElement('audio');
      a.muted = true; a.autoplay = true;
      a.srcObject = new MediaStream([track]);
      a.play().catch(() => {});
      const src = ac.createMediaStreamSource(new MediaStream([track]));
      src.connect(dest);
      p.el = a; p.src = src;
    }
  }

  function fit(el, x, y, w, h) {
    const vw = el.videoWidth, vh = el.videoHeight;
    if (!vw || !vh) return;
    const s = Math.min(w / vw, h / vh);
    const dw = vw * s, dh = vh * s;
    g.drawImage(el, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
  }

  function draw() {
    g.fillStyle = '#0b0f14'; g.fillRect(0, 0, W, H);
    const list = [...pulled.values()].filter((p) => p.el && p.kind !== 'AUDIO' && p.kind !== 'SCREEN_AUDIO');
    const screen = list.find((p) => p.kind === 'SCREEN');
    const cam = list.find((p) => p.kind === 'VIDEO' && p.role === 'TEACHER');
    const students = list.filter((p) => p.kind === 'VIDEO' && p.role !== 'TEACHER');
    if (screen) {
      fit(screen.el, 0, 0, W, H);
      if (cam) { g.fillStyle = '#000'; g.fillRect(W - 336, H - 196, 320, 180); fit(cam.el, W - 336, H - 196, 320, 180); }
    } else if (cam) {
      fit(cam.el, 0, 0, W, H);
    } else {
      g.fillStyle = '#8a94a6'; g.font = '28px sans-serif'; g.textAlign = 'center';
      g.fillText('Darsly', W / 2, H / 2);
    }
    students.slice(0, 4).forEach((p, i) => {
      const x = 16 + i * 256, y = H - 160;
      g.fillStyle = '#000'; g.fillRect(x, y, 240, 135); fit(p.el, x, y, 240, 135);
    });
  }

  async function sync() {
    const st = await window.__state();
    if (st.stop) return finish(st.reason);
    const want = new Map(st.tracks.map((t) => [t.id, t]));
    const drop = [...pulled.keys()].filter((id) => !want.has(id));
    const add = [...want.keys()].filter((id) => !pulled.has(id));
    if (drop.length) {
      const mids = [];
      for (const id of drop) {
        const p = pulled.get(id); pulled.delete(id);
        if (p.src) try { p.src.disconnect(); } catch {}
        if (p.el) { p.el.srcObject = null; }
        mids.push(p.mid);
        const tr = pc.getTransceivers().find((x) => x.mid === p.mid);
        try { tr && tr.stop(); } catch {}
      }
      try {
        const o = await pc.createOffer(); await pc.setLocalDescription(o);
        const r = await window.__cf('close', { mids, offer: { type: 'offer', sdp: o.sdp } });
        if (r && r.sessionDescription) await pc.setRemoteDescription(r.sessionDescription);
      } catch (e) { log('close failed: ' + e); }
    }
    if (add.length) {
      const r = await window.__cf('subscribe', { trackIds: add });
      for (const t of r.tracks) {
        const info = want.get(t.trackId);
        if (!t.mid || t.error || !info) continue;
        const p = { mid: t.mid, kind: info.kind, role: info.role, userId: info.userId, el: null };
        pulled.set(t.trackId, p);
        const track = byMid.get(t.mid);
        if (track) attach(t.trackId, p, track);
      }
      if (r.requiresImmediateRenegotiation && r.sessionDescription) {
        await pc.setRemoteDescription(r.sessionDescription);
        const a = await pc.createAnswer(); await pc.setLocalDescription(a);
        await window.__cf('renegotiate', { answer: { type: 'answer', sdp: a.sdp } });
      }
      for (const [id, p] of pulled) { const tr = byMid.get(p.mid); if (tr && !p.el) attach(id, p, tr); }
    }
  }

  let done;
  window.__finished = new Promise((r) => (done = r));
  async function finish(reason) {
    if (stopping) return;
    stopping = true;
    log('stopping: ' + reason);
    while (rotating) await new Promise((r) => setTimeout(r, 50));
    const cleanup = async () => {
      // Let the last chunk's upload to Node finish before saying so.
      await window.__pending;
      try { pc.close(); } catch {}
      done({ reason });
    };
    // Stopped mid-rotation: the old piece is already closed and no new one began.
    if (!rec || rec.state === 'inactive') return cleanup();
    rec.onstop = cleanup;
    try { rec.stop(); } catch { cleanup(); }
  }

  let stream;
  function newRecorder() {
    const r = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp8,opus', videoBitsPerSecond: 1_800_000, audioBitsPerSecond: 96_000 });
    r.ondataavailable = (e) => {
      if (!e.data || !e.data.size) return;
      window.__pending = window.__pending.then(async () => {
        const buf = new Uint8Array(await e.data.arrayBuffer());
        let s = '';
        for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
        await window.__chunk(btoa(s));
      });
    };
    return r;
  }

  // A new piece every few minutes: each finished piece is uploaded at once,
  // so a recorder that dies loses at most the piece it was writing.
  let rotating = false;
  async function rotate() {
    if (stopping || rotating) return;
    rotating = true;
    const old = rec;
    await new Promise((res) => { old.onstop = res; try { old.stop(); } catch { res(); } });
    await window.__pending;
    if (!stopping) {
      await window.__segment();
      rec = newRecorder();
      rec.start(CHUNK_MS);
    }
    rotating = false;
  }

  window.__start = async ({ iceServers, segmentMs }) => {
    ac = new AudioContext();
    dest = ac.createMediaStreamDestination();
    // A silent source keeps the audio track alive before anyone speaks.
    const osc = ac.createConstantSource(); osc.offset.value = 0; osc.connect(dest); osc.start();
    pc = new RTCPeerConnection({ iceServers, bundlePolicy: 'max-bundle' });
    pc.ontrack = (e) => {
      const mid = e.transceiver && e.transceiver.mid;
      if (!mid) return;
      byMid.set(mid, e.track);
      for (const [id, p] of pulled) if (p.mid === mid) attach(id, p, e.track);
    };
    setInterval(draw, 1000 / FPS);
    stream = new MediaStream([...cv.captureStream(FPS).getVideoTracks(), ...dest.stream.getAudioTracks()]);
    window.__pending = Promise.resolve();
    rec = newRecorder();
    rec.start(CHUNK_MS);
    if (segmentMs) setInterval(rotate, segmentMs);
    const loop = async () => {
      if (stopping) return;
      try { await sync(); } catch (e) { log('sync: ' + e); }
      if (!stopping) setTimeout(loop, 2000);
    };
    loop();
    return true;
  };
})();
</script></body></html>`;
