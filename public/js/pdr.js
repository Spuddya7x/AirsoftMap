/* ------------------------------------------------------------------ *
 * Pedestrian dead reckoning.
 *
 * Underground there is no GPS and no phone signal, so the only thing
 * left is the phone's own sensors: count steps, estimate how long each
 * one was, and point them in the direction the handset is facing.
 *
 * Two things make this usable rather than a toy:
 *
 *  1. Step length is estimated per step from how hard the step hit
 *     (Weinberg's estimator, length ~ (a_max - a_min)^1/4), so a creep
 *     and a sprint are not treated as the same distance, and the
 *     constant is calibrated per player from real legs between two
 *     known points.
 *  2. Error is tracked and shown. Dead reckoning always drifts; the
 *     honest thing is to draw the uncertainty growing on the map and
 *     let a check-in at a known point collapse it back to nothing.
 * ------------------------------------------------------------------ */
(function (global) {
  'use strict';

  const DEFAULT_K = 0.48;      // metres per (m/s^2)^(1/4); calibrated per player
  const MIN_STEP_MS = 240;     // fastest believable step cadence
  const MAX_STEP_MS = 2200;    // slower than this and we assume they stopped
  const MIN_SWING = 1.3;       // peak-to-peak accel that counts as a step (m/s^2)
  const DRIFT_PER_METRE = 0.18; // uncertainty added per metre walked
  const DRIFT_FLOOR = 4;       // uncertainty right after a check-in (m)

  function PDR() {
    this.running = false;
    this.k = DEFAULT_K;
    this.steps = 0;              // total steps this session
    this.legSteps = 0;           // steps since the last known-good fix
    this.legSwing = 0;           // sum of (a_max - a_min)^(1/4) since that fix
    this.legDistance = 0;        // estimated metres since that fix
    this.heading = null;         // degrees, magnetic/true from the handset
    this.headingJitter = 0;      // rough measure of how unstable the compass is
    this.cadence = 0;            // steps per minute
    this.onStep = null;          // (metres, headingDeg) => void
    this.onHeading = null;       // (headingDeg) => void

    this._lp = 9.81;             // low-passed accel magnitude
    this._mean = 9.81;           // slow-moving baseline
    this._peak = -Infinity;
    this._trough = Infinity;
    this._above = false;
    this._lastStepAt = 0;
    this._recentHeadings = [];
    this._onMotion = this._motion.bind(this);
    this._onOrient = this._orient.bind(this);
  }

  PDR.supported = function () {
    return typeof DeviceMotionEvent !== 'undefined';
  };

  /** Must be called from a user gesture: iOS gates the sensors behind one. */
  PDR.prototype.start = async function () {
    if (this.running) return true;
    try {
      if (typeof DeviceMotionEvent !== 'undefined' &&
          typeof DeviceMotionEvent.requestPermission === 'function') {
        const ok = await DeviceMotionEvent.requestPermission();
        if (ok !== 'granted') return false;
      }
      if (typeof DeviceOrientationEvent !== 'undefined' &&
          typeof DeviceOrientationEvent.requestPermission === 'function') {
        await DeviceOrientationEvent.requestPermission().catch(() => {});
      }
    } catch (err) {
      return false;
    }

    window.addEventListener('devicemotion', this._onMotion);
    if ('ondeviceorientationabsolute' in window) {
      window.addEventListener('deviceorientationabsolute', this._onOrient);
    }
    window.addEventListener('deviceorientation', this._onOrient);
    this.running = true;
    return true;
  };

  PDR.prototype.stop = function () {
    window.removeEventListener('devicemotion', this._onMotion);
    window.removeEventListener('deviceorientationabsolute', this._onOrient);
    window.removeEventListener('deviceorientation', this._onOrient);
    this.running = false;
  };

  /* --- step detection ------------------------------------------------ */

  PDR.prototype._motion = function (ev) {
    const a = ev.accelerationIncludingGravity || ev.acceleration;
    if (!a || a.x == null) return;
    const mag = Math.sqrt(a.x * a.x + a.y * a.y + a.z * a.z);

    /* Low pass to kill sensor noise, plus a slower baseline that tracks
       however the phone happens to be held. */
    this._lp += 0.28 * (mag - this._lp);
    this._mean += 0.02 * (this._lp - this._mean);

    if (this._lp > this._peak) this._peak = this._lp;
    if (this._lp < this._trough) this._trough = this._lp;

    const now = ev.timeStamp && ev.timeStamp > 1e9 ? ev.timeStamp : Date.now();
    const crossingUp = !this._above && this._lp > this._mean + 0.35;
    const crossingDown = this._above && this._lp < this._mean - 0.05;

    if (crossingUp) this._above = true;

    if (crossingDown) {
      this._above = false;
      const swing = this._peak - this._trough;
      const since = now - this._lastStepAt;
      this._peak = -Infinity;
      this._trough = Infinity;

      if (swing >= MIN_SWING && since >= MIN_STEP_MS) {
        this._lastStepAt = now;
        this.cadence = since < MAX_STEP_MS ? Math.round(60000 / since) : 0;

        /* Weinberg: taller acceleration swing => longer stride. */
        const swing14 = Math.pow(Math.min(swing, 40), 0.25);
        const length = this.k * swing14;

        this.steps++;
        this.legSteps++;
        this.legSwing += swing14;
        this.legDistance += length;

        if (this.onStep) this.onStep(length, this.heading);
      }
    }
  };

  /* --- heading -------------------------------------------------------- */

  PDR.prototype._orient = function (ev) {
    let heading = null;
    if (typeof ev.webkitCompassHeading === 'number') {
      heading = ev.webkitCompassHeading;             // iOS, already true-ish north
    } else if (ev.absolute && typeof ev.alpha === 'number') {
      heading = (360 - ev.alpha) % 360;              // Android absolute frame
    } else if (typeof ev.alpha === 'number' && this.heading == null) {
      heading = (360 - ev.alpha) % 360;              // relative: better than nothing
    }
    if (heading == null || Number.isNaN(heading)) return;

    this.heading = heading;

    /* If the compass is swinging wildly the phone is probably next to
       something steel - worth telling the player about. */
    this._recentHeadings.push(heading);
    if (this._recentHeadings.length > 20) this._recentHeadings.shift();
    if (this._recentHeadings.length === 20) {
      let spread = 0;
      for (let i = 1; i < this._recentHeadings.length; i++) {
        let d = Math.abs(this._recentHeadings[i] - this._recentHeadings[i - 1]);
        if (d > 180) d = 360 - d;
        spread += d;
      }
      this.headingJitter = spread / 19;
    }
    if (this.onHeading) this.onHeading(heading);
  };

  /* --- calibration ---------------------------------------------------- */

  /** Called when a fix of known position lands: starts a fresh leg. */
  PDR.prototype.beginLeg = function () {
    this.legSteps = 0;
    this.legSwing = 0;
    this.legDistance = 0;
  };

  /**
   * Learn this player's stride from a leg they just walked between two
   * known points. Only trusted for a decent number of steps, because a
   * short leg is mostly turning and shuffling.
   * Returns the new constant, or null if the leg was not usable.
   */
  PDR.prototype.calibrate = function (trueDistance) {
    if (!(trueDistance > 5) || this.legSteps < 12 || this.legSwing <= 0) return null;
    const measured = trueDistance / this.legSwing;
    if (!(measured > 0.15) || measured > 1.2) return null;   // implausible stride
    this.k = this.k * 0.4 + measured * 0.6;
    return this.k;
  };

  /** Uncertainty radius (metres) after walking this far since a real fix. */
  PDR.uncertainty = function (metresSinceFix, compassJitter) {
    const heading = compassJitter > 12 ? 0.12 : 0;   // bad compass, worse drift
    return Math.min(250, DRIFT_FLOOR + metresSinceFix * (DRIFT_PER_METRE + heading));
  };

  PDR.DRIFT_FLOOR = DRIFT_FLOOR;
  global.PDR = PDR;
})(window);
