// input.js — keyboard + Gamepad, per CONTRACT §7.
// Consumers only ever read ctx.input.state. Analogue axes are smoothed towards
// their target so keyboard control does not feel like an on/off switch, while
// gamepad axes pass through at full fidelity.

import { clamp, clamp01, damp } from '../core/rng.js';

const DEADZONE = 0.16;
const TRIGGER_DEADZONE = 0.06;
// Keyboard ramp rates (units/second towards target). Attack faster than release
// so inputs feel responsive but do not snap back and unsettle the bike.
const AXIS_ATTACK = 9.0;
const AXIS_RELEASE = 13.0;
const TRIGGER_ATTACK = 7.5;
const TRIGGER_RELEASE = 11.0;

/** Radial deadzone with rescale, so the usable range still reaches 1.0. */
function applyDeadzone(v, dz) {
  const a = Math.abs(v);
  if (a <= dz) return 0;
  return Math.sign(v) * ((a - dz) / (1 - dz));
}

export function createInput(ctx) {
  const state = {
    steer: 0, pitch: 0, roll: 0,
    brakeFront: 0, brakeRear: 0,
    pedal: 0, pump: 0,
    manual: false,
    reset: false, pause: false, cameraCycle: false, photoMode: false,
    anyPressed: false,
  };

  // Held-key set and edge-triggered set (consumed once per frame).
  const down = new Set();
  const pressedEdge = new Set();
  let gamepadIndex = -1;
  let lastGamepadActivity = -Infinity;

  const isTyping = () => {
    const el = document.activeElement;
    if (!el) return false;
    const tag = el.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
  };

  function onKeyDown(e) {
    if (isTyping()) return;
    const code = e.code;
    if (!down.has(code)) pressedEdge.add(code);
    down.add(code);
    // Stop the page scrolling / the browser eating our controls.
    if (code === 'Space' || code.startsWith('Arrow') || code === 'Tab') e.preventDefault();
  }
  function onKeyUp(e) {
    down.delete(e.code);
  }
  function onBlur() {
    // Never leave a key stuck on when focus leaves the window.
    down.clear();
    pressedEdge.clear();
    touch.steerX = 0; touch.steerY = 0;
    touch.brakeF = false; touch.brakeR = false;
    touch.pedal = false; touch.pump = false; touch.manual = false;
    touch.rollL = false; touch.rollR = false; touch.active = false;
    touch.reset = false; touch.pause = false; touch.cameraCycle = false; touch.photoMode = false;
    stickPointerId = -1;
    heldPointers.clear();
    if (touchRoot) {
      const held = touchRoot.querySelectorAll('.held');
      for (let i = 0; i < held.length; i++) held[i].classList.remove('held');
    }
    setKnob(0, 0);
  }
  function onGamepadConnected(e) {
    gamepadIndex = e.gamepad.index;
  }
  function onGamepadDisconnected(e) {
    if (gamepadIndex === e.gamepad.index) gamepadIndex = -1;
  }

  // ---- touch controls (mobile) ------------------------------------------
  // A DOM overlay built once: left thumb-stick (steer + pitch), right action
  // cluster (brakes / pedal / pump / manual / roll), top-right system keys.
  // Shown only on touch-capable devices so desktop screenshots and QA are
  // unaffected. All targets merge into the same keyboard/gamepad targets in
  // update() — consumers keep reading ctx.input.state unchanged.
  const TOUCH_CSS = `
  #dsc-touch { position: fixed; inset: 0; z-index: 40; pointer-events: none;
    font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
    -webkit-user-select: none; user-select: none; -webkit-tap-highlight-color: transparent;
    display: none; contain: layout style; }
  #dsc-touch.on { display: block; }
  #dsc-touch .tk-stick { position: absolute; pointer-events: auto; touch-action: none;
    left: calc(18px + env(safe-area-inset-left, 0px));
    bottom: calc(86px + env(safe-area-inset-bottom, 0px));
    width: 128px; height: 128px; border-radius: 999px;
    background: rgba(5,9,14,0.42); box-shadow: inset 0 0 0 1px rgba(226,240,252,0.18);
    backdrop-filter: blur(2px); -webkit-backdrop-filter: blur(2px); }
  #dsc-touch .tk-knob { position: absolute; left: 50%; top: 50%;
    width: 56px; height: 56px; margin: -28px 0 0 -28px; border-radius: 999px;
    background: radial-gradient(circle at 35% 30%, rgba(255,255,255,0.85), rgba(214,228,242,0.55) 60%, rgba(125,238,255,0.55));
    box-shadow: 0 2px 10px rgba(0,0,0,0.5); will-change: transform; }
  #dsc-touch .tk-lbl { position: absolute; left: 0; right: 0; bottom: -18px; text-align: center;
    font-size: 9px; font-weight: 700; letter-spacing: 0.22em; color: rgba(214,228,242,0.5); }
  #dsc-touch .tk-cluster { position: absolute; pointer-events: none;
    right: calc(14px + env(safe-area-inset-right, 0px));
    bottom: calc(86px + env(safe-area-inset-bottom, 0px));
    display: grid; grid-template-columns: repeat(2, 68px); gap: 10px; }
  #dsc-touch .tk-btn { pointer-events: auto; touch-action: none;
    width: 68px; height: 68px; border-radius: 999px; border: 1px solid rgba(226,240,252,0.20);
    background: rgba(5,9,14,0.46); color: rgba(242,247,252,0.92);
    font-size: 10px; font-weight: 800; letter-spacing: 0.08em;
    display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 1px;
    backdrop-filter: blur(2px); -webkit-backdrop-filter: blur(2px); }
  #dsc-touch .tk-btn small { font-size: 8px; font-weight: 600; letter-spacing: 0.14em; color: rgba(214,228,242,0.55); }
  #dsc-touch .tk-btn.hot { border-color: rgba(255,106,43,0.65); }
  #dsc-touch .tk-btn.acc { border-color: rgba(125,238,255,0.55); }
  #dsc-touch .tk-btn.held { background: rgba(125,238,255,0.28); border-color: rgba(125,238,255,0.9); }
  #dsc-touch .tk-btn.hot.held { background: rgba(255,106,43,0.32); border-color: rgba(255,106,43,0.95); }
  #dsc-touch .tk-mini-row { position: absolute; pointer-events: none;
    right: calc(14px + env(safe-area-inset-right, 0px));
    bottom: calc(86px + env(safe-area-inset-bottom, 0px) + 156px);
    display: flex; gap: 8px; }
  #dsc-touch .tk-mini { pointer-events: auto; touch-action: none;
    min-width: 52px; height: 34px; padding: 0 10px; border-radius: 8px;
    border: 1px solid rgba(226,240,252,0.20); background: rgba(5,9,14,0.46);
    color: rgba(242,247,252,0.9); font-size: 10px; font-weight: 800; letter-spacing: 0.1em; }
  #dsc-touch .tk-mini.held { background: rgba(125,238,255,0.28); border-color: rgba(125,238,255,0.9); }
  #dsc-touch .tk-sys { position: absolute; pointer-events: none;
    top: calc(12px + env(safe-area-inset-top, 0px));
    right: calc(12px + env(safe-area-inset-right, 0px)); display: flex; gap: 8px; }
  #dsc-touch .tk-sys button { pointer-events: auto; touch-action: none;
    min-width: 44px; height: 36px; padding: 0 10px; border-radius: 8px;
    border: 1px solid rgba(226,240,252,0.20); background: rgba(5,9,14,0.46);
    color: rgba(242,247,252,0.9); font-size: 11px; font-weight: 800; }
  @media (orientation: portrait) {
    #dsc-touch .tk-stick { width: 112px; height: 112px; bottom: calc(120px + env(safe-area-inset-bottom, 0px)); }
    #dsc-touch .tk-cluster { grid-template-columns: repeat(2, 62px); }
    #dsc-touch .tk-btn { width: 62px; height: 62px; }
  }
  @media (prefers-reduced-motion: reduce) { #dsc-touch .tk-knob { will-change: auto; } }
  `;

  const touch = {
    steerX: 0, steerY: 0,           // stick -1..1 (y: + = up on screen)
    brakeF: false, brakeR: false,
    pedal: false, pump: false, manual: false,
    rollL: false, rollR: false,
    active: false,                   // any touch target currently held
    reset: false, pause: false, cameraCycle: false, photoMode: false,
  };
  let touchRoot = null, touchKnob = null, touchStickEl = null;
  let touchSeen = false;             // a real touch event has fired
  let stickPointerId = -1;
  let stickRadius = 44;
  const heldPointers = new Set();    // pointerIds currently down on any control

  function touchForceParam() {
    try {
      const p = new URLSearchParams(location.search).get('touch');
      if (p === '1') return true;
      if (p === '0') return false;
    } catch (e) { /* ignore */ }
    return null;
  }
  const touchForced = touchForceParam();

  function touchShouldShow() {
    if (touchForced === true) return true;
    if (touchForced === false) return false;
    if (touchSeen) return true;
    try {
      if (navigator.maxTouchPoints > 0) return true;
      if (window.matchMedia && window.matchMedia('(pointer: coarse)').matches) return true;
      if ('ontouchstart' in window) return true;
    } catch (e) { /* ignore */ }
    return false;
  }

  function touchRefreshVisibility() {
    if (!touchRoot) return;
    touchRoot.classList.toggle('on', touchShouldShow());
  }

  function markTouchSeen() {
    if (!touchSeen) { touchSeen = true; touchRefreshVisibility(); }
  }

  function setKnob(dx, dy) {
    if (!touchKnob) return;
    touchKnob.style.transform = `translate3d(${dx.toFixed(1)}px,${dy.toFixed(1)}px,0)`;
  }

  function stickSetFromEvent(e) {
    if (!touchStickEl) return;
    const r = touchStickEl.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    stickRadius = Math.max(30, r.width / 2 - 12);
    let dx = e.clientX - cx, dy = e.clientY - cy;
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len > stickRadius) { dx = dx / len * stickRadius; dy = dy / len * stickRadius; }
    touch.steerX = dx / stickRadius;
    touch.steerY = -dy / stickRadius;   // screen-up = pitch +1 (weight forward, like W / stick-up)
    touch.active = true;
    setKnob(dx, dy);
  }

  function stickRelease() {
    stickPointerId = -1;
    touch.steerX = 0; touch.steerY = 0;
    setKnob(0, 0);
    if (heldPointers.size === 0) touch.active = false;
  }

  function bindHoldButton(elm, onChange) {
    let pid = -1;
    const downFn = (e) => {
      e.preventDefault(); e.stopPropagation();
      markTouchSeen();
      pid = e.pointerId;
      heldPointers.add(e.pointerId);
      touch.active = true;
      try { elm.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      elm.classList.add('held');
      onChange(true);
    };
    const upFn = (e) => {
      if (pid !== -1 && e.pointerId !== pid) return;
      pid = -1;
      heldPointers.delete(e.pointerId);
      elm.classList.remove('held');
      onChange(false);
      if (heldPointers.size === 0 && stickPointerId === -1) touch.active = false;
    };
    elm.addEventListener('pointerdown', downFn);
    elm.addEventListener('pointerup', upFn);
    elm.addEventListener('pointercancel', upFn);
    elm.addEventListener('lostpointercapture', upFn);
    // Prevent iOS double-tap zoom / callout on long-press.
    elm.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  function bindEdgeButton(elm, fire) {
    elm.addEventListener('pointerdown', (e) => {
      e.preventDefault(); e.stopPropagation();
      markTouchSeen();
      touch.active = true;
      heldPointers.add(e.pointerId);
      setTimeout(() => heldPointers.delete(e.pointerId), 250);
      fire();
    });
    elm.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  function buildTouchUI() {
    if (touchRoot || typeof document === 'undefined') return;
    const style = document.createElement('style');
    style.id = 'dsc-touch-style';
    style.textContent = TOUCH_CSS;
    document.head.appendChild(style);

    const root = document.createElement('div');
    root.id = 'dsc-touch';
    root.setAttribute('aria-hidden', 'true');

    // Left stick.
    const stick = document.createElement('div');
    stick.className = 'tk-stick';
    stick.setAttribute('aria-label', 'Steer and lean');
    const knob = document.createElement('div');
    knob.className = 'tk-knob';
    stick.appendChild(knob);
    const stickLbl = document.createElement('div');
    stickLbl.className = 'tk-lbl';
    stickLbl.textContent = 'STEER · LEAN';
    stick.appendChild(stickLbl);
    root.appendChild(stick);
    touchStickEl = stick; touchKnob = knob;

    stick.addEventListener('pointerdown', (e) => {
      e.preventDefault(); e.stopPropagation();
      markTouchSeen();
      stickPointerId = e.pointerId;
      heldPointers.add(e.pointerId);
      try { stick.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      stickSetFromEvent(e);
    });
    stick.addEventListener('pointermove', (e) => {
      if (e.pointerId !== stickPointerId) return;
      e.preventDefault();
      stickSetFromEvent(e);
    });
    const stickUp = (e) => {
      if (e.pointerId !== stickPointerId) return;
      heldPointers.delete(e.pointerId);
      stickRelease();
    };
    stick.addEventListener('pointerup', stickUp);
    stick.addEventListener('pointercancel', stickUp);
    stick.addEventListener('lostpointercapture', stickUp);
    stick.addEventListener('contextmenu', (e) => e.preventDefault());

    // Right action cluster: brakes, pedal, pump.
    const cluster = document.createElement('div');
    cluster.className = 'tk-cluster';
    const mkBtn = (label, sub, cls) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'tk-btn' + (cls ? ' ' + cls : '');
      b.tabIndex = -1;
      const s = document.createElement('span');
      s.textContent = label;
      b.appendChild(s);
      if (sub) { const sm = document.createElement('small'); sm.textContent = sub; b.appendChild(sm); }
      cluster.appendChild(b);
      return b;
    };
    bindHoldButton(mkBtn('F-BRK', 'front', 'hot'), (v) => { touch.brakeF = v; });
    bindHoldButton(mkBtn('R-BRK', 'rear', 'hot'), (v) => { touch.brakeR = v; });
    bindHoldButton(mkBtn('PEDAL', 'sprint', 'acc'), (v) => { touch.pedal = v; });
    bindHoldButton(mkBtn('PUMP', 'hold·let go', 'acc'), (v) => { touch.pump = v; });
    root.appendChild(cluster);

    // Mini row above the cluster: manual + air roll.
    const miniRow = document.createElement('div');
    miniRow.className = 'tk-mini-row';
    const mkMini = (label) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'tk-mini';
      b.tabIndex = -1;
      b.textContent = label;
      miniRow.appendChild(b);
      return b;
    };
    bindHoldButton(mkMini('MAN'), (v) => { touch.manual = v; });
    bindHoldButton(mkMini('◀ ROLL'), (v) => { touch.rollL = v; });
    bindHoldButton(mkMini('ROLL ▶'), (v) => { touch.rollR = v; });
    root.appendChild(miniRow);

    // System keys, top-right.
    const sys = document.createElement('div');
    sys.className = 'tk-sys';
    const mkSys = (label, title) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = label;
      b.title = title || label;
      b.tabIndex = -1;
      sys.appendChild(b);
      return b;
    };
    bindEdgeButton(mkSys('⏸', 'Pause'), () => { touch.pause = true; });
    bindEdgeButton(mkSys('↺', 'Reset to checkpoint'), () => { touch.reset = true; });
    bindEdgeButton(mkSys('📷', 'Camera'), () => { touch.cameraCycle = true; });
    root.appendChild(sys);

    (ctx && ctx.container ? ctx.container : document.body).appendChild(root);
    touchRoot = root;
    touchRefreshVisibility();
  }

  function onFirstTouch() { markTouchSeen(); }

  buildTouchUI();
  window.addEventListener('touchstart', onFirstTouch, { passive: true });
  window.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'touch') markTouchSeen();
  }, { passive: true });

  window.addEventListener('keydown', onKeyDown, { passive: false });
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', onBlur);
  window.addEventListener('gamepadconnected', onGamepadConnected);
  window.addEventListener('gamepaddisconnected', onGamepadDisconnected);

  const held = (...codes) => codes.some((c) => down.has(c));
  const tapped = (...codes) => codes.some((c) => pressedEdge.has(c));

  function pollGamepad() {
    if (!navigator.getGamepads) return null;
    const pads = navigator.getGamepads();
    if (!pads) return null;
    if (gamepadIndex >= 0 && pads[gamepadIndex]) return pads[gamepadIndex];
    for (let i = 0; i < pads.length; i++) {
      if (pads[i] && pads[i].connected) { gamepadIndex = i; return pads[i]; }
    }
    return null;
  }

  // Previous button states for gamepad edge detection.
  const prevButtons = new Uint8Array(24);

  function update(dt) {
    const d = Math.min(dt || 0, 1 / 20);

    // ---- keyboard targets -------------------------------------------------
    let steerT = (held('KeyD', 'ArrowRight') ? 1 : 0) - (held('KeyA', 'ArrowLeft') ? 1 : 0);
    let pitchT = (held('KeyW', 'ArrowUp') ? 1 : 0) - (held('KeyS', 'ArrowDown') ? 1 : 0);
    let rollT = (held('KeyE') ? 1 : 0) - (held('KeyQ') ? 1 : 0);
    let brakeFT = held('KeyJ') ? 1 : 0;
    let brakeRT = held('KeyK') ? 1 : 0;
    let pedalT = held('ShiftLeft', 'ShiftRight') ? 1 : 0;
    let pumpT = held('Space') ? 1 : 0;
    let manual = held('KeyM');

    let reset = tapped('KeyR');
    let pause = tapped('Escape', 'KeyP');
    let cameraCycle = tapped('KeyC');
    let photoMode = tapped('KeyF');
    let anyKeyboard = down.size > 0;

    // ---- gamepad overrides / merges --------------------------------------
    const pad = pollGamepad();
    let padActive = false;
    if (pad) {
      const ax = pad.axes || [];
      const gSteer = applyDeadzone(ax[0] || 0, DEADZONE);
      // Stick Y is +down on every mainstream pad; contract pitch is + = back/up.
      const gPitch = applyDeadzone(-(ax[1] || 0), DEADZONE);
      const gRoll = applyDeadzone(ax[2] || 0, DEADZONE);

      const btn = (i) => (pad.buttons && pad.buttons[i]) || null;
      const val = (i) => { const b = btn(i); return b ? (b.value !== undefined ? b.value : (b.pressed ? 1 : 0)) : 0; };
      const pressed = (i) => { const b = btn(i); return !!(b && b.pressed); };

      // Standard mapping: 6 = L2, 7 = R2, 4 = L1, 5 = R1, 0 = A/X, 1 = B/O,
      // 2 = X/□, 3 = Y/△, 9 = Start, 8 = Select, 10 = L3.
      let gBrakeF = val(6);
      let gBrakeR = val(7);
      if (gBrakeF < TRIGGER_DEADZONE) gBrakeF = 0;
      if (gBrakeR < TRIGGER_DEADZONE) gBrakeR = 0;
      const gPedal = Math.max(val(5), pressed(5) ? 1 : 0);
      const gPump = pressed(0) ? 1 : 0;

      padActive = Math.abs(gSteer) > 0 || Math.abs(gPitch) > 0 || Math.abs(gRoll) > 0 ||
                  gBrakeF > 0 || gBrakeR > 0 || gPedal > 0 || gPump > 0;
      if (padActive) lastGamepadActivity = ctx.time;

      // Take whichever device is asking for more — lets you mix devices without
      // one zeroing the other out.
      if (Math.abs(gSteer) > Math.abs(steerT)) steerT = gSteer;
      if (Math.abs(gPitch) > Math.abs(pitchT)) pitchT = gPitch;
      if (Math.abs(gRoll) > Math.abs(rollT)) rollT = gRoll;
      brakeFT = Math.max(brakeFT, gBrakeF);
      brakeRT = Math.max(brakeRT, gBrakeR);
      pedalT = Math.max(pedalT, gPedal);
      pumpT = Math.max(pumpT, gPump);
      manual = manual || pressed(2);

      // Edge-detect the discrete buttons.
      const n = Math.min(prevButtons.length, (pad.buttons || []).length);
      for (let i = 0; i < n; i++) {
        const now = pressed(i) ? 1 : 0;
        const edge = now && !prevButtons[i];
        if (edge) {
          if (i === 1) reset = true;         // B / circle
          if (i === 9) pause = true;         // start
          if (i === 3) cameraCycle = true;   // Y / triangle
          if (i === 8) photoMode = true;     // select / share
        }
        prevButtons[i] = now;
      }
    }

    // ---- touch merges (same max-wins policy as gamepad) --------------------
    const tSteer = applyDeadzone(touch.steerX || 0, DEADZONE);
    const tPitch = applyDeadzone(touch.steerY || 0, DEADZONE);
    const tRoll = (touch.rollR ? 1 : 0) - (touch.rollL ? 1 : 0);
    if (Math.abs(tSteer) > Math.abs(steerT)) steerT = tSteer;
    if (Math.abs(tPitch) > Math.abs(pitchT)) pitchT = tPitch;
    if (Math.abs(tRoll) > Math.abs(rollT)) rollT = tRoll;
    brakeFT = Math.max(brakeFT, touch.brakeF ? 1 : 0);
    brakeRT = Math.max(brakeRT, touch.brakeR ? 1 : 0);
    pedalT = Math.max(pedalT, touch.pedal ? 1 : 0);
    pumpT = Math.max(pumpT, touch.pump ? 1 : 0);
    manual = manual || touch.manual;
    if (touch.reset) { reset = true; touch.reset = false; }
    if (touch.pause) { pause = true; touch.pause = false; }
    if (touch.cameraCycle) { cameraCycle = true; touch.cameraCycle = false; }
    if (touch.photoMode) { photoMode = true; touch.photoMode = false; }
    const touchActive = touch.active ||
      Math.abs(tSteer) > 0 || Math.abs(tPitch) > 0 || tRoll !== 0 ||
      brakeFT > 0 || brakeRT > 0 || pedalT > 0 || pumpT > 0 || !!manual;

    // Gamepad/touch axes are already analogue, so only smooth when keyboard-led.
    const smoothing = (padActive || touchActive) ? 1 : 0;
    const rate = (target, current, attack, release) => {
      if (smoothing) return target;
      const r = Math.abs(target) > Math.abs(current) ? attack : release;
      return damp(current, target, r, d);
    };

    state.steer = clamp(rate(steerT, state.steer, AXIS_ATTACK, AXIS_RELEASE), -1, 1);
    state.pitch = clamp(rate(pitchT, state.pitch, AXIS_ATTACK, AXIS_RELEASE), -1, 1);
    state.roll = clamp(rate(rollT, state.roll, AXIS_ATTACK, AXIS_RELEASE), -1, 1);
    state.brakeFront = clamp01(rate(brakeFT, state.brakeFront, TRIGGER_ATTACK, TRIGGER_RELEASE));
    state.brakeRear = clamp01(rate(brakeRT, state.brakeRear, TRIGGER_ATTACK, TRIGGER_RELEASE));
    state.pedal = clamp01(rate(pedalT, state.pedal, TRIGGER_ATTACK, TRIGGER_RELEASE));
    // Pump is deliberately un-smoothed: the release edge is the whole mechanic.
    state.pump = clamp01(pumpT);

    state.manual = !!manual;
    state.reset = reset;
    state.pause = pause;
    state.cameraCycle = cameraCycle;
    state.photoMode = photoMode;
    state.anyPressed = anyKeyboard || padActive || touchActive;

    pressedEdge.clear();
  }

  return {
    state,
    update,

    /** Impact rumble, if the pad supports it. Safe to call every frame. */
    rumble(strength = 0.5, durationMs = 120) {
      const pad = pollGamepad();
      const act = pad && (pad.vibrationActuator ||
        (pad.hapticActuators && pad.hapticActuators[0]));
      if (!act || typeof act.playEffect !== 'function') return;
      const s = clamp01(strength);
      try {
        act.playEffect('dual-rumble', {
          startDelay: 0,
          duration: Math.max(20, durationMs),
          weakMagnitude: s * 0.8,
          strongMagnitude: s,
        });
      } catch (e) { /* pad does not support it; ignore */ }
    },

    get hasGamepad() { return gamepadIndex >= 0; },
    get lastGamepadActivity() { return lastGamepadActivity; },
    get isTouch() { return touchShouldShow(); },
    get touchActive() { return touch.active; },

    dispose() {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('gamepadconnected', onGamepadConnected);
      window.removeEventListener('gamepaddisconnected', onGamepadDisconnected);
      window.removeEventListener('touchstart', onFirstTouch);
      if (touchRoot && touchRoot.parentNode) touchRoot.parentNode.removeChild(touchRoot);
      const st = document.getElementById('dsc-touch-style');
      if (st && st.parentNode) st.parentNode.removeChild(st);
      touchRoot = null;
    },
  };
}
