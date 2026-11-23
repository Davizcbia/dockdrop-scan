// Render only the camera strip behind the two controls. The scanner reads the video separately.
const VERTEX = `
attribute vec2 position;
void main() { gl_Position = vec4(position, 0.0, 1.0); }
`;

const FRAGMENT = `
precision mediump float;
uniform sampler2D camera;
uniform vec2 size;
uniform vec4 bounds;

void main() {
  vec2 pixel = vec2(gl_FragCoord.x, size.y - gl_FragCoord.y);
  vec2 halfSize = bounds.zw * 0.5;
  vec2 local = pixel - bounds.xy - halfSize;
  float radius = min(halfSize.x, halfSize.y);
  vec2 axis = vec2(clamp(local.x, radius - halfSize.x, halfSize.x - radius), 0.0);
  vec2 radial = local - axis;
  float distance = length(radial);
  float depth = radius - distance;
  if (depth < -0.5) discard;

  vec2 normal = radial / max(distance, 0.5);
  float curvature = 1.0 - smoothstep(0.0, 12.0, depth);
  vec2 refracted = pixel - normal * (1.2 + 9.0 * curvature * curvature);
  vec2 offset = vec2(1.7) / size;
  vec2 uv = refracted / size;
  vec3 color = texture2D(camera, uv).rgb * 0.52;
  color += 0.12 * (texture2D(camera, uv + offset).rgb + texture2D(camera, uv - offset).rgb);
  offset.x = -offset.x;
  color += 0.12 * (texture2D(camera, uv + offset).rgb + texture2D(camera, uv - offset).rgb);
  float rim = exp(-max(depth, 0.0) * 0.48);
  float light = clamp(dot(normal, vec2(-0.30, -0.95)), 0.0, 1.0);
  color = mix(color * 0.70, vec3(0.10, 0.14, 0.21), 0.25);
  color += rim * (0.05 + 0.14 * light) + curvature * 0.035 * light;
  gl_FragColor = vec4(color, smoothstep(-0.5, 0.9, depth));
}
`;

const CONTRAST = '(prefers-reduced-transparency: reduce), (prefers-contrast: more)';

function compile(gl, kind, source) {
  const shader = gl.createShader(kind);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (gl.getShaderParameter(shader, gl.COMPILE_STATUS)) return shader;
  gl.deleteShader(shader);
  throw new Error('Camera glass shader compilation failed');
}

export function startCameraGlass(video, controls) {
  const preferences = matchMedia(CONTRAST);
  if (preferences.matches) return null;
  const canvas = document.createElement('canvas');
  canvas.className = 'camera-glass';
  canvas.setAttribute('aria-hidden', 'true');
  const gl = canvas.getContext('webgl', { alpha: true, premultipliedAlpha: false, antialias: false });
  if (!gl) return null;
  const source = document.createElement('canvas');
  const camera = source.getContext('2d', { alpha: false });
  if (!camera) return null;

  const program = gl.createProgram();
  let vertex, fragment;
  try {
    vertex = compile(gl, gl.VERTEX_SHADER, VERTEX);
    fragment = compile(gl, gl.FRAGMENT_SHADER, FRAGMENT);
    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error('Camera glass shader linking failed');
  } catch {
    gl.deleteProgram(program);
    return null;
  } finally {
    if (vertex) gl.deleteShader(vertex);
    if (fragment) gl.deleteShader(fragment);
  }
  gl.useProgram(program);
  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const position = gl.getAttribLocation(program, 'position');
  gl.enableVertexAttribArray(position);
  gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
  const size = gl.getUniformLocation(program, 'size');
  const bounds = gl.getUniformLocation(program, 'bounds');
  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.uniform1i(gl.getUniformLocation(program, 'camera'), 0);
  gl.clearColor(0, 0, 0, 0);
  controls[0].before(canvas);

  let frame, stopped = false;
  let lastDraw = -Infinity;
  const usesVideoFrames = typeof video.requestVideoFrameCallback === 'function';
  function stop() {
    if (stopped) return;
    stopped = true;
    if (usesVideoFrames) video.cancelVideoFrameCallback(frame);
    else cancelAnimationFrame(frame);
    preferences.removeEventListener('change', stop);
    document.body.classList.remove('refraction-active');
    canvas.remove();
    gl.deleteTexture(texture);
    gl.deleteBuffer(buffer);
    gl.deleteProgram(program);
  }
  canvas.addEventListener('webglcontextlost', stop, { once: true });
  preferences.addEventListener('change', stop, { once: true });

  function draw() {
    const width = window.innerWidth;
    const viewHeight = window.innerHeight;
    const rects = controls.map((control) => control.getBoundingClientRect());
    const height = Math.min(viewHeight, Math.ceil(Math.max(...rects.map((rect) => rect.bottom)) + 12));
    if (!width || !height || !video.videoWidth || !video.videoHeight) return;
    if (width !== canvas.width || height !== canvas.height) {
      source.width = canvas.width = width;
      source.height = canvas.height = height;
      canvas.style.height = `${height}px`;
      gl.viewport(0, 0, width, height);
      gl.uniform2f(size, width, height);
    }
    // Match the preview's object-fit: cover so lines continue across the lens.
    const cover = Math.max(width / video.videoWidth, viewHeight / video.videoHeight);
    const left = (video.videoWidth - width / cover) * 0.5;
    const top = (video.videoHeight - viewHeight / cover) * 0.5;
    camera.drawImage(video, left, top, width / cover, height / cover, 0, 0, width, height);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    gl.disable(gl.SCISSOR_TEST);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.SCISSOR_TEST);
    for (const rect of rects) {
      if (rect.width <= 0 || rect.height <= 0) continue;
      const x = Math.floor(rect.left - 1), y = Math.floor(height - rect.bottom - 1);
      gl.scissor(x, y, Math.ceil(rect.right + 1) - x, Math.ceil(height - rect.top + 1) - y);
      gl.uniform4f(bounds, rect.left, rect.top, rect.width, rect.height);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
    document.body.classList.add('refraction-active');
  }

  function tick(now) {
    if (stopped) return;
    if (now - lastDraw >= 32 && video.readyState >= 2) {
      try { draw(); } catch { stop(); return; }
      lastDraw = now;
    }
    schedule();
  }
  function schedule() {
    frame = usesVideoFrames ? video.requestVideoFrameCallback(tick) : requestAnimationFrame(tick);
  }
  schedule();
  return stop;
}
