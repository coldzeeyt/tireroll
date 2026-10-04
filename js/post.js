// Post-processing: the scene renders to an HDR (half-float) target, then a
// composite pass adds bloom and sun rays, applies ACES filmic tone mapping,
// a light grade, vignette and grain, and encodes to sRGB.
// Needs WebGL2; on WebGL1 the renderer draws directly with ACES instead.
(function (root) {
  const TR = root.TR;

  const QUAD_VS = `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

  const BRIGHT_FS = `
    uniform sampler2D tSrc; uniform float uThreshold;
    varying vec2 vUv;
    void main() {
      vec3 c = max(texture2D(tSrc, vUv).rgb, vec3(0.0));
      float l = max(c.r, max(c.g, c.b));
      if (!(l < 1e4)) { c = vec3(0.0); l = 0.0; } // drop NaN/inf so they can't bloom
      float k = smoothstep(uThreshold, uThreshold * 1.8, l);
      gl_FragColor = vec4(min(c * k, vec3(40.0)), 1.0);
    }`;

  const BLUR_FS = `
    uniform sampler2D tSrc; uniform vec2 uDir;
    varying vec2 vUv;
    void main() {
      vec3 s = texture2D(tSrc, vUv).rgb * 0.227027;
      s += texture2D(tSrc, vUv + uDir * 1.3846).rgb * 0.3162162;
      s += texture2D(tSrc, vUv - uDir * 1.3846).rgb * 0.3162162;
      s += texture2D(tSrc, vUv + uDir * 3.2308).rgb * 0.0702703;
      s += texture2D(tSrc, vUv - uDir * 3.2308).rgb * 0.0702703;
      gl_FragColor = vec4(s, 1.0);
    }`;

  const COMP_FS = `
    uniform sampler2D tScene; uniform sampler2D tBloomA; uniform sampler2D tBloomB; uniform sampler2D tRays;
    uniform vec2 uSun; uniform float uSunVis; uniform vec3 uSunCol; uniform float uRays;
    uniform float uExposure; uniform float uBloom; uniform vec3 uLift; uniform vec3 uGain; uniform float uSat;
    uniform float uTime; uniform vec2 uRes; uniform float uAspect;
    varying vec2 vUv;
    vec3 RRTAndODTFit(vec3 v) {
      vec3 a = v * (v + 0.0245786) - 0.000090537;
      vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081;
      return a / b;
    }
    vec3 aces(vec3 c) {
      const mat3 inM = mat3(vec3(0.59719, 0.07600, 0.02840), vec3(0.35458, 0.90834, 0.13383), vec3(0.04823, 0.01566, 0.83777));
      const mat3 outM = mat3(vec3(1.60475, -0.10208, -0.00327), vec3(-0.53108, 1.10813, -0.07276), vec3(-0.07367, -0.00605, 1.07602));
      c *= uExposure / 0.6;
      return clamp(outM * RRTAndODTFit(inM * c), 0.0, 1.0);
    }
    vec3 toSRGB(vec3 c) {
      return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), c));
    }
    float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
    void main() {
      vec3 c = texture2D(tScene, vUv).rgb;
      if (!(dot(c, vec3(1.0)) < 1e5)) c = vec3(0.0);
      c += (texture2D(tBloomA, vUv).rgb * 0.55 + texture2D(tBloomB, vUv).rgb * 0.75) * uBloom;
      // sun rays: march the bright buffer toward the sun
      if (uSunVis > 0.001) {
        vec2 d = (vUv - uSun) / 28.0;
        vec2 st = vUv;
        float decay = 1.0, acc = 0.0;
        for (int i = 0; i < 28; i++) {
          st -= d;
          vec3 s = texture2D(tRays, st).rgb;
          acc += dot(s, vec3(0.333)) * decay;
          decay *= 0.955;
        }
        vec2 dd = (vUv - uSun) * vec2(uAspect, 1.0);
        float fall = 1.0 - smoothstep(0.0, 1.1, length(dd));
        c += uSunCol * acc / 28.0 * uRays * uSunVis * fall;
      }
      c = aces(c);
      // grade: lift/gain and saturation, in display space
      c = toSRGB(c);
      float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
      c = mix(vec3(l), c, uSat);
      c = uLift + c * (uGain - uLift);
      // vignette
      vec2 v = (vUv - 0.5) * vec2(uAspect, 1.0);
      c *= 1.0 - smoothstep(0.45, 1.25, length(v)) * 0.32;
      // grain hides banding in the sky
      c += (hash(vUv * uRes + fract(uTime) * 91.7) - 0.5) * 0.018;
      gl_FragColor = vec4(c, 1.0);
    }`;

  class Post {
    constructor(renderer, quality) {
      this.r = renderer;
      this.enabled = renderer.capabilities.isWebGL2;
      this.quality = quality;
      if (!this.enabled) return;
      const type = THREE.HalfFloatType;
      const opts = { type, format: THREE.RGBAFormat, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false };
      if (quality === 'high' && THREE.WebGLMultisampleRenderTarget) {
        this.sceneRT = new THREE.WebGLMultisampleRenderTarget(4, 4, { type, format: THREE.RGBAFormat });
        this.sceneRT.samples = 4;
      } else {
        this.sceneRT = new THREE.WebGLRenderTarget(4, 4, { type, format: THREE.RGBAFormat });
      }
      this.a1 = new THREE.WebGLRenderTarget(4, 4, opts);
      this.a2 = new THREE.WebGLRenderTarget(4, 4, opts);
      this.b1 = new THREE.WebGLRenderTarget(4, 4, opts);
      this.b2 = new THREE.WebGLRenderTarget(4, 4, opts);
      this.cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
      this.quadScene = new THREE.Scene();
      this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), null);
      this.quad.frustumCulled = false;
      this.quadScene.add(this.quad);
      const mk = (fs, uniforms) => new THREE.ShaderMaterial({ vertexShader: QUAD_VS, fragmentShader: fs, uniforms, depthTest: false, depthWrite: false, toneMapped: false });
      this.bright = mk(BRIGHT_FS, { tSrc: { value: null }, uThreshold: { value: 1.6 } });
      this.blur = mk(BLUR_FS, { tSrc: { value: null }, uDir: { value: new THREE.Vector2() } });
      this.comp = mk(COMP_FS, {
        tScene: { value: null }, tBloomA: { value: null }, tBloomB: { value: null }, tRays: { value: null },
        uSun: { value: new THREE.Vector2() }, uSunVis: { value: 0 }, uSunCol: { value: new THREE.Color() }, uRays: { value: 1.0 },
        uExposure: { value: 1.0 }, uBloom: { value: 0.6 }, uLift: { value: new THREE.Vector3(0, 0, 0) }, uGain: { value: new THREE.Vector3(1, 1, 1) },
        uSat: { value: 1.06 }, uTime: { value: 0 }, uRes: { value: new THREE.Vector2(1, 1) }, uAspect: { value: 1 },
      });
      this._v = new THREE.Vector3();
    }

    setSize(w, h, pr) {
      if (!this.enabled) return;
      const W = Math.max(4, Math.floor(w * pr)), H = Math.max(4, Math.floor(h * pr));
      this.sceneRT.setSize(W, H);
      const s1 = this.quality === 'high' ? 2 : 4;
      this.a1.setSize(Math.ceil(W / s1), Math.ceil(H / s1));
      this.a2.setSize(Math.ceil(W / s1), Math.ceil(H / s1));
      this.b1.setSize(Math.ceil(W / (s1 * 4)), Math.ceil(H / (s1 * 4)));
      this.b2.setSize(Math.ceil(W / (s1 * 4)), Math.ceil(H / (s1 * 4)));
      this.comp.uniforms.uRes.value.set(W, H);
      this.comp.uniforms.uAspect.value = w / h;
    }

    // per-map look
    setLook(map, sunColor) {
      if (!this.enabled) return;
      const g = map.grade || {};
      const u = this.comp.uniforms;
      u.uExposure.value = g.exposure || 1.0;
      u.uBloom.value = g.bloom !== undefined ? g.bloom : 0.6;
      u.uRays.value = g.rays !== undefined ? g.rays : 1.0;
      u.uSat.value = g.sat || 1.06;
      u.uLift.value.set(...(g.lift || [0.012, 0.014, 0.02]));
      u.uGain.value.set(...(g.gain || [1, 1, 1]));
      u.uSunCol.value.copy(sunColor);
    }

    pass(mat, target) {
      this.quad.material = mat;
      this.r.setRenderTarget(target);
      this.r.render(this.quadScene, this.cam);
    }

    render(scene, camera, sunDir, time) {
      const r = this.r;
      if (!this.enabled) {
        r.setRenderTarget(null);
        r.render(scene, camera);
        return;
      }
      r.setRenderTarget(this.sceneRT);
      r.render(scene, camera);
      // bright pass + two blur levels
      this.bright.uniforms.tSrc.value = this.sceneRT.texture;
      this.pass(this.bright, this.a1);
      const bl = this.blur.uniforms;
      bl.tSrc.value = this.a1.texture; bl.uDir.value.set(1 / this.a1.width, 0); this.pass(this.blur, this.a2);
      bl.tSrc.value = this.a2.texture; bl.uDir.value.set(0, 1 / this.a1.height); this.pass(this.blur, this.a1);
      bl.tSrc.value = this.a1.texture; bl.uDir.value.set(2 / this.a1.width, 0); this.pass(this.blur, this.b1);
      bl.tSrc.value = this.b1.texture; bl.uDir.value.set(0, 1 / this.b1.height); this.pass(this.blur, this.b2);
      bl.tSrc.value = this.b2.texture; bl.uDir.value.set(1 / this.b1.width, 0); this.pass(this.blur, this.b1);
      bl.tSrc.value = this.b1.texture; bl.uDir.value.set(0, 1 / this.b1.height); this.pass(this.blur, this.b2);
      // sun position on screen
      const u = this.comp.uniforms;
      const v = this._v.copy(sunDir).multiplyScalar(1000).add(camera.position).project(camera);
      const fwd = camera.getWorldDirection(new THREE.Vector3());
      const facing = fwd.dot(sunDir);
      u.uSun.value.set(v.x * 0.5 + 0.5, v.y * 0.5 + 0.5);
      const onScreen = 1 - TR.clamp((Math.max(Math.abs(v.x), Math.abs(v.y)) - 1) / 0.6, 0, 1);
      u.uSunVis.value = facing > 0 ? onScreen * TR.clamp(facing * 2, 0, 1) : 0;
      u.tScene.value = this.sceneRT.texture;
      u.tBloomA.value = this.a1.texture;
      u.tBloomB.value = this.b2.texture;
      u.tRays.value = this.a1.texture;
      u.uTime.value = time;
      this.pass(this.comp, null);
    }
  }

  TR.Post = Post;
})(typeof window !== 'undefined' ? window : globalThis);
