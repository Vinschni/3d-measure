// Three.js Scene Setup
let scene, camera, renderer, controls, mesh;
let selectedPoints = [];
let pointMarkers   = [];   // spheres — kept across live re-runs
let measureVisuals = [];   // lines/circles — rebuilt each measurement run
let markerScale = 1.0;
let displayScale = 1.0; // scene units per mm — geometry is scaled to fit the view,
                        // so every measured value must be divided by this
let measurementMode = 'line'; // 'line' | 'circle' | 'caliper' | 'bore'
let measurementPlane = null;
let planeVisual = null;
let planeAxisMode = 'normal';

const AXIS_NORMALS = {
    x: new THREE.Vector3(1, 0, 0),
    y: new THREE.Vector3(0, 1, 0),
    z: new THREE.Vector3(0, 0, 1),
};

const raycaster = new THREE.Raycaster();
const mouse = new THREE.Vector2();
let occt = null; // occt-import-js instance, loaded lazily

const MODE_CONFIG = {
    line:    { required: 2, label: 'Distance',      color: 0x4caf50 },
    circle:  { required: 3, label: 'Diameter',      color: 0xe040fb },
    caliper: { required: 2, label: 'Caliper Width', color: 0xff9800 },
    bore:    { required: 0, label: 'Bore Ø',        color: 0x00e5ff }, // 0 = unlimited
};

const MODE_INSTRUCTIONS = {
    line:    'Click point <strong>1</strong> on the mesh — it sets the plane.<br>Click point <strong>2</strong> to complete the measurement.',
    circle:  'Click <strong>3 points</strong> on the rim of a circle.<br>Point 1 sets the plane.',
    caliper: 'Click <strong>2 points</strong> to define an axis.<br>Point 1 sets the plane.',
    bore:    'Click <strong>3 or more points</strong> anywhere on the inner wall.<br>Best-fit diameter updates live after each click.',
};

// ── Init ──────────────────────────────────────────────────────────────────────

function init() {
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x242428);

    const canvas = document.getElementById('canvas');
    camera = new THREE.PerspectiveCamera(75, canvas.clientWidth / canvas.clientHeight, 0.1, 10000);
    camera.position.set(0, 0, 100);

    renderer = new THREE.WebGLRenderer({ antialias: true, precision: 'highp' });
    renderer.setSize(canvas.clientWidth, canvas.clientHeight);
    renderer.setPixelRatio(window.devicePixelRatio);
    canvas.appendChild(renderer.domElement);

    controls = new THREE.OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.05;
    controls.screenSpacePanning = true;

    // Hemisphere: warm sky above, cool ground below — gives natural ambient shading
    scene.add(new THREE.HemisphereLight(0xfff4e0, 0x303050, 0.6));

    // Key light — strong, top-front-right
    const key = new THREE.DirectionalLight(0xfff8f0, 1.1);
    key.position.set(80, 120, 80);
    scene.add(key);

    // Fill light — softer, left side, slightly cool
    const fill = new THREE.DirectionalLight(0xd0e8ff, 0.35);
    fill.position.set(-100, 40, 60);
    scene.add(fill);

    // Rim / back light — defines silhouette edges
    const rim = new THREE.DirectionalLight(0xffffff, 0.25);
    rim.position.set(0, -60, -120);
    scene.add(rim);

    scene.add(new THREE.GridHelper(200, 20, 0x383838, 0x282828));

    document.getElementById('file-input').addEventListener('change', handleFileUpload);
    document.getElementById('clear-measurement').addEventListener('click', clearMeasurement);
    document.getElementById('reset-view').addEventListener('click', resetView);
    document.getElementById('marker-size').addEventListener('input', onMarkerSizeChange);

    document.querySelectorAll('.mode-btn').forEach(btn => {
        btn.addEventListener('click', () => setMode(btn.dataset.mode));
    });

    document.querySelectorAll('.axis-btn').forEach(btn => {
        btn.addEventListener('click', () => setPlaneAxis(btn.dataset.axis));
    });

    // Drag detection — prevents ghost points when rotating
    let pointerMoved = false;
    renderer.domElement.addEventListener('pointerdown', () => { pointerMoved = false; });
    renderer.domElement.addEventListener('pointermove', () => { pointerMoved = true; });
    renderer.domElement.addEventListener('pointerup', (e) => {
        if (!pointerMoved && e.button === 0) onCanvasClick(e);
        pointerMoved = false;
    });

    window.addEventListener('resize', onWindowResize);

    setMode('line');
    animate();
}

// ── Plane axis selection ──────────────────────────────────────────────────────

const AXIS_HINTS = {
    normal: 'Plane follows surface normal at click point',
    x: 'Plane cuts perpendicular to X  — use for cylinders along X',
    y: 'Plane cuts perpendicular to Y  — use for cylinders along Y',
    z: 'Plane cuts perpendicular to Z  — use for cylinders along Z',
};

function setPlaneAxis(axis) {
    planeAxisMode = axis;
    document.querySelectorAll('.axis-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.axis === axis);
    });
    document.getElementById('axis-hint').textContent = AXIS_HINTS[axis];
    clearMeasurement();
}

// ── Mode ──────────────────────────────────────────────────────────────────────

function setMode(mode) {
    measurementMode = mode;
    clearMeasurement();
    document.querySelectorAll('.mode-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.mode === mode);
    });
    document.getElementById('mode-instructions').innerHTML = MODE_INSTRUCTIONS[mode];
    updatePointCountUI();
}

// ── File loading ──────────────────────────────────────────────────────────────

function handleFileUpload(event) {
    const file = event.target.files[0];
    if (!file) return;
    showLoading(true);
    document.getElementById('file-name').textContent = 'Loading: ' + file.name;

    const isStep = /\.(step|stp)$/i.test(file.name);

    const reader = new FileReader();
    reader.onload = (e) => {
        if (isStep) {
            loadSTEP(e.target.result, file.name);
        } else {
            try {
                setTimeout(() => {
                    loadMesh(parseSTL(e.target.result));
                    document.getElementById('file-name').textContent = '✓ ' + file.name;
                    showLoading(false);
                }, 100);
            } catch (err) {
                showLoading(false);
                document.getElementById('file-name').textContent = '✗ Error: ' + err.message;
                console.error(err);
            }
        }
    };
    reader.onerror = () => {
        showLoading(false);
        document.getElementById('file-name').textContent = '✗ Failed to read file';
    };
    reader.readAsArrayBuffer(file);
}

async function loadSTEP(arrayBuffer, fileName) {
    try {
        if (!occt) {
            document.getElementById('file-name').textContent = 'Initialising STEP engine…';
            occt = await occtimportjs({ locateFile: (f) =>
                'https://cdn.jsdelivr.net/npm/occt-import-js@0.0.12/dist/' + f
            });
        }

        const fileBuffer = new Uint8Array(arrayBuffer);
        occt.FS.writeFile('/model.step', fileBuffer);
        const result = occt.ReadStepFile('/model.step', null);

        if (!result.success) throw new Error('STEP parsing failed');

        // Merge all solid meshes into one BufferGeometry
        const allVerts = [], allNorms = [];
        for (const mesh of result.meshes) {
            const coords    = mesh.attributes.position.array;
            const normCoords = mesh.attributes.normal.array;
            if (mesh.index) {
                for (const idx of mesh.index.array) {
                    allVerts.push(coords[idx * 3], coords[idx * 3 + 1], coords[idx * 3 + 2]);
                    allNorms.push(normCoords[idx * 3], normCoords[idx * 3 + 1], normCoords[idx * 3 + 2]);
                }
            } else {
                allVerts.push(...coords);
                allNorms.push(...normCoords);
            }
        }

        if (!allVerts.length) throw new Error('No geometry in STEP file');

        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(allVerts), 3));
        geo.setAttribute('normal',   new THREE.BufferAttribute(new Float32Array(allNorms), 3));
        geo.computeVertexNormals();

        loadMesh(geo);
        document.getElementById('file-name').textContent = '✓ ' + fileName;
        showLoading(false);
    } catch (err) {
        showLoading(false);
        document.getElementById('file-name').textContent = '✗ Error: ' + err.message;
        console.error(err);
    }
}

// ── STL parsing ───────────────────────────────────────────────────────────────

function parseSTL(buf) {
    const header = new TextDecoder().decode(new Uint8Array(buf, 0, 5));
    return header === 'solid'
        ? parseASCIISTL(new TextDecoder().decode(buf))
        : parseBinarySTL(new DataView(buf));
}

function parseBinarySTL(view) {
    const faces = view.getUint32(80, true);
    const expectedSize = 84 + faces * 50;
    if (view.byteLength < expectedSize)
        throw new Error(`File too small (${view.byteLength} < ${expectedSize})`);

    const verts = new Float32Array(faces * 9);
    const norms = new Float32Array(faces * 9);
    let off = 84, vi = 0, ni = 0;
    for (let i = 0; i < faces; i++) {
        const nx = view.getFloat32(off, true); off += 4;
        const ny = view.getFloat32(off, true); off += 4;
        const nz = view.getFloat32(off, true); off += 4;
        for (let j = 0; j < 3; j++) {
            verts[vi++] = view.getFloat32(off, true); off += 4;
            verts[vi++] = view.getFloat32(off, true); off += 4;
            verts[vi++] = view.getFloat32(off, true); off += 4;
            norms[ni++] = nx; norms[ni++] = ny; norms[ni++] = nz;
        }
        off += 2;
    }
    if (!verts.length) throw new Error('No vertices parsed');
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(verts, 3));
    geo.setAttribute('normal',   new THREE.BufferAttribute(norms, 3));
    geo.computeVertexNormals();
    return geo;
}

function parseASCIISTL(data) {
    const verts = [], norms = [];
    const facetRe = /facet normal\s+([\S]+)\s+([\S]+)\s+([\S]+)\s+outer loop([\s\S]*?)endloop/g;
    let fm;
    while ((fm = facetRe.exec(data)) !== null) {
        const nx = +fm[1], ny = +fm[2], nz = +fm[3];
        const vRe = /vertex\s+([\S]+)\s+([\S]+)\s+([\S]+)/g;
        let vm;
        while ((vm = vRe.exec(fm[4])) !== null) {
            verts.push(+vm[1], +vm[2], +vm[3]);
            norms.push(nx, ny, nz);
        }
    }
    if (!verts.length) throw new Error('No vertices in ASCII STL');
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(verts), 3));
    geo.setAttribute('normal',   new THREE.BufferAttribute(new Float32Array(norms), 3));
    geo.computeVertexNormals();
    return geo;
}

function loadMesh(geometry) {
    if (mesh) scene.remove(mesh);
    geometry.center();
    geometry.computeBoundingBox();
    const s = geometry.boundingBox.getSize(new THREE.Vector3());
    const scale = 50 / Math.max(s.x, s.y, s.z);
    geometry.scale(scale, scale, scale);
    displayScale = scale;

    mesh = new THREE.Mesh(geometry, new THREE.MeshPhongMaterial({
        color:    0xd4cfc8,  // warm light grey — shows shading clearly
        specular: 0x888880,  // subtle specular highlight on edges
        emissive: 0x080808,
        shininess: 40,
        side: THREE.DoubleSide
    }));
    scene.add(mesh);
    resetView();
    clearMeasurement();
}

// ── Click / point selection ───────────────────────────────────────────────────

function onCanvasClick(event) {
    if (!mesh) return;
    const canvas = document.getElementById('canvas');
    const rect = canvas.getBoundingClientRect();

    mouse.x = ((event.clientX - rect.left) / rect.width)  * 2 - 1;
    mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

    raycaster.setFromCamera(mouse, camera);
    const hits = raycaster.intersectObject(mesh);
    if (!hits.length) return;

    const rawPoint = hits[0].point.clone();
    // face normal → world space
    const worldNormal = hits[0].face.normal.clone().transformDirection(mesh.matrixWorld);

    addPoint(rawPoint, worldNormal);
}

function addPoint(rawPoint, worldNormal) {
    const cfg = MODE_CONFIG[measurementMode];
    const isBore = measurementMode === 'bore';

    // Fixed-count modes: auto-clear when full
    if (!isBore && cfg.required > 0 && selectedPoints.length >= cfg.required) clearMeasurement();

    let point;
    if (selectedPoints.length === 0) {
        const normal = planeAxisMode === 'normal'
            ? worldNormal
            : AXIS_NORMALS[planeAxisMode].clone();
        measurementPlane = new THREE.Plane().setFromNormalAndCoplanarPoint(normal, rawPoint);
        showPlaneVisual(rawPoint, normal);
        point = rawPoint;
    } else {
        point = new THREE.Vector3();
        measurementPlane.projectPoint(rawPoint, point);
    }

    selectedPoints.push(point);
    addPointMarker(point, isBore ? 2 : selectedPoints.length - 1); // bore points all same colour
    updatePointCountUI();

    if (!isBore && selectedPoints.length === cfg.required) runMeasurement();
    if (isBore  && selectedPoints.length >= 3)             runMeasurement();
}

// ── Plane visual ──────────────────────────────────────────────────────────────

function showPlaneVisual(origin, normal) {
    if (planeVisual) { scene.remove(planeVisual); planeVisual = null; }

    const bbox = new THREE.Box3().setFromObject(mesh);
    const size = bbox.getSize(new THREE.Vector3());
    const dim  = Math.max(size.x, size.y, size.z) * 1.5;

    // Disc face
    const geo = new THREE.CircleGeometry(dim * 0.5, 64);
    const group = new THREE.Group();

    group.add(new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
        color: 0xffdd44, opacity: 0.10, transparent: true,
        side: THREE.DoubleSide, depthWrite: false
    })));

    // Disc border
    const pts = [];
    for (let i = 0; i <= 64; i++) {
        const a = (i / 64) * Math.PI * 2;
        pts.push(new THREE.Vector3(Math.cos(a) * dim * 0.5, Math.sin(a) * dim * 0.5, 0));
    }
    group.add(new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(pts),
        new THREE.LineBasicMaterial({ color: 0xffdd44, opacity: 0.7, transparent: true })
    ));

    // Normal arrow to show which side is "up"
    const arrowLen = dim * 0.15;
    group.add(new THREE.Line(
        new THREE.BufferGeometry().setFromPoints([
            new THREE.Vector3(0, 0, 0),
            new THREE.Vector3(0, 0, arrowLen)
        ]),
        new THREE.LineBasicMaterial({ color: 0xffdd44, opacity: 0.8, transparent: true })
    ));

    // Orient: PlaneGeometry/CircleGeometry lies in XY, normal = +Z.
    // lookAt makes the group's +Z face toward (origin + normal).
    group.position.copy(origin);
    group.lookAt(origin.clone().add(normal));

    scene.add(group);
    planeVisual = group;
}

// ── Markers ───────────────────────────────────────────────────────────────────

function getMarkerRadius() {
    if (!mesh) return 1;
    const size = new THREE.Box3().setFromObject(mesh).getSize(new THREE.Vector3());
    return Math.max(size.x, size.y, size.z) * 0.015 * markerScale;
}

function addPointMarker(point, index) {
    const colors = [0xff6b6b, 0xffa500, 0xffff00];
    const geo = new THREE.SphereGeometry(getMarkerRadius(), 16, 16);
    const mat = new THREE.MeshBasicMaterial({ color: colors[index] ?? 0xffffff });
    const marker = new THREE.Mesh(geo, mat);
    marker.position.copy(point);
    scene.add(marker);
    pointMarkers.push(marker);
}

function onMarkerSizeChange(event) {
    markerScale = parseFloat(event.target.value);
    document.getElementById('marker-size-value').textContent = markerScale.toFixed(1) + '×';
    const r = getMarkerRadius();
    pointMarkers.forEach(obj => {
        if (obj.isMesh && obj.geometry.type === 'SphereGeometry') {
            obj.geometry.dispose();
            obj.geometry = new THREE.SphereGeometry(r, 16, 16);
        }
    });
}

// ── Measurement dispatch ──────────────────────────────────────────────────────

function runMeasurement() {
    // Clear previous measurement drawings (keep point markers)
    measureVisuals.forEach(o => scene.remove(o));
    measureVisuals = [];

    const pts = selectedPoints;
    let value, label;

    if (measurementMode === 'line') {
        value = pts[0].distanceTo(pts[1]);
        label = 'Distance';
        addMeasureLine(pts[0], pts[1], 0x4caf50);

    } else if (measurementMode === 'circle') {
        const r = fitCircle3(pts[0], pts[1], pts[2]);
        if (!r) { showResult('— (collinear)', 'Diameter'); return; }
        value = r.radius * 2;
        label = 'Diameter';
        drawCircle(r.center, r.normal, r.radius, 0xe040fb);
        [0, 1, 2].forEach(i => addMeasureLine(pts[i], pts[(i + 1) % 3], 0x555555));

    } else if (measurementMode === 'caliper') {
        const r = caliperWidth(pts[0], pts[1]);
        value = r.width;
        label = 'Caliper Width';
        addMeasureLine(r.minPt, r.maxPt, 0xff9800);
        addMeasureLine(pts[0], pts[1], 0x444444);
        addEndCap(r.minPt, r.axis, 0xff9800);
        addEndCap(r.maxPt, r.axis, 0xff9800);

    } else if (measurementMode === 'bore') {
        const r = fitBoreCircle(pts);
        if (!r) { showResult('— (need 3+ pts)', 'Bore Ø'); return; }
        value = r.radius * 2;
        label = 'Bore Ø';
        drawCircle(r.center, r.normal, r.radius, 0x00e5ff);
    }

    showResult((value / displayScale).toFixed(3), label);
}

// ── Line ──────────────────────────────────────────────────────────────────────

function addMeasureLine(a, b, color) {
    const line = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints([a, b]),
        new THREE.LineBasicMaterial({ color })
    );
    scene.add(line);
    measureVisuals.push(line);
}

// ── Circle ────────────────────────────────────────────────────────────────────

function fitCircle3(p1, p2, p3) {
    const ab = new THREE.Vector3().subVectors(p2, p1);
    const ac = new THREE.Vector3().subVectors(p3, p1);
    const cross = new THREE.Vector3().crossVectors(ab, ac);
    const crossLen = cross.length();
    if (crossLen < 1e-10) return null;

    const normal = cross.clone().normalize();
    const xAxis  = ab.clone().normalize();
    const yAxis  = new THREE.Vector3().crossVectors(normal, xAxis);

    const abLen = ab.length();
    const P3x = ac.dot(xAxis);
    const P3y = ac.dot(yAxis);
    if (Math.abs(P3y) < 1e-10) return null;

    const cx = abLen / 2;
    const cy = (ac.dot(ac) - 2 * cx * P3x) / (2 * P3y);
    const radius = Math.sqrt(cx * cx + cy * cy);
    const center = p1.clone().addScaledVector(xAxis, cx).addScaledVector(yAxis, cy);

    return { center, normal, radius };
}

function drawCircle(center, normal, radius, color) {
    const u = Math.abs(normal.dot(new THREE.Vector3(1, 0, 0))) > 0.9
        ? new THREE.Vector3(0, 1, 0)
        : new THREE.Vector3(1, 0, 0);
    const right = new THREE.Vector3().crossVectors(normal, u).normalize();
    const up    = new THREE.Vector3().crossVectors(right, normal).normalize();

    const pts = [];
    for (let i = 0; i <= 64; i++) {
        const a = (i / 64) * Math.PI * 2;
        pts.push(center.clone()
            .addScaledVector(right, Math.cos(a) * radius)
            .addScaledVector(up,    Math.sin(a) * radius));
    }
    const ring = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(pts),
        new THREE.LineBasicMaterial({ color })
    );
    scene.add(ring);
    measureVisuals.push(ring);

    const dot = new THREE.Mesh(
        new THREE.SphereGeometry(getMarkerRadius() * 0.6, 10, 10),
        new THREE.MeshBasicMaterial({ color })
    );
    dot.position.copy(center);
    scene.add(dot);
    measureVisuals.push(dot);

    addMeasureLine(center.clone().addScaledVector(right,  radius),
                   center.clone().addScaledVector(right, -radius), color);
}

// ── Bore (algebraic least-squares circle fit) ─────────────────────────────────

function fitBoreCircle(pts3d) {
    if (!measurementPlane || pts3d.length < 3) return null;

    // Build a 2D orthonormal frame on the measurement plane
    const normal = measurementPlane.normal.clone();
    const xAxis  = Math.abs(normal.x) < 0.9
        ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
    xAxis.crossVectors(normal, xAxis).normalize();
    const yAxis = new THREE.Vector3().crossVectors(xAxis, normal).normalize();
    const origin = pts3d[0];

    // Project all 3D points to 2D
    const pts2d = pts3d.map(p => {
        const d = new THREE.Vector3().subVectors(p, origin);
        return { x: d.dot(xAxis), y: d.dot(yAxis) };
    });

    // Algebraic circle fit  (x²+y² + Dx + Ey + F = 0)
    // Centre the data for numerical stability
    let mx = 0, my = 0;
    pts2d.forEach(p => { mx += p.x; my += p.y; });
    mx /= pts2d.length; my /= pts2d.length;
    const cp = pts2d.map(p => ({ x: p.x - mx, y: p.y - my }));

    let Sxx=0, Sxy=0, Sxz=0, Syy=0, Syz=0, Sx=0, Sy=0, Sz=0;
    const n = cp.length;
    cp.forEach(p => {
        const z = p.x*p.x + p.y*p.y;
        Sxx += p.x*p.x; Sxy += p.x*p.y; Sxz += p.x*z;
        Syy += p.y*p.y; Syz += p.y*z;
        Sx  += p.x;     Sy  += p.y;     Sz  += z;
    });

    // Solve [Sxx Sxy Sx | -Sxz]
    //       [Sxy Syy Sy | -Syz]
    //       [Sx  Sy   n | -Sz ]  via Gaussian elimination
    const M = [
        [Sxx, Sxy, Sx,  -Sxz],
        [Sxy, Syy, Sy,  -Syz],
        [Sx,  Sy,  n,   -Sz ],
    ];
    for (let i = 0; i < 3; i++) {
        let maxR = i;
        for (let j = i+1; j < 3; j++) if (Math.abs(M[j][i]) > Math.abs(M[maxR][i])) maxR = j;
        [M[i], M[maxR]] = [M[maxR], M[i]];
        if (Math.abs(M[i][i]) < 1e-12) return null;
        for (let j = i+1; j < 3; j++) {
            const f = M[j][i] / M[i][i];
            for (let k = i; k <= 3; k++) M[j][k] -= f * M[i][k];
        }
    }
    const DEF = [0, 0, 0];
    for (let i = 2; i >= 0; i--) {
        DEF[i] = M[i][3];
        for (let j = i+1; j < 3; j++) DEF[i] -= M[i][j] * DEF[j];
        DEF[i] /= M[i][i];
    }
    const [D, E, F] = DEF;

    // 2D circle centre (in centred frame, then shift back)
    const cx2d = -D/2 + mx;
    const cy2d = -E/2 + my;
    const radius = Math.sqrt(D*D/4 + E*E/4 - F);
    if (!isFinite(radius) || radius <= 0) return null;

    // Back to 3D
    const center = origin.clone()
        .addScaledVector(xAxis, cx2d)
        .addScaledVector(yAxis, cy2d);

    return { center, normal, radius };
}

// ── Caliper ───────────────────────────────────────────────────────────────────

function caliperWidth(p1, p2) {
    const axis = new THREE.Vector3().subVectors(p2, p1).normalize();
    const pos  = mesh.geometry.attributes.position;
    mesh.updateMatrixWorld(true);
    const mat = mesh.matrixWorld;

    let minProj = Infinity, maxProj = -Infinity;
    const minPt = new THREE.Vector3(), maxPt = new THREE.Vector3();
    const v = new THREE.Vector3();

    for (let i = 0; i < pos.count; i++) {
        v.fromBufferAttribute(pos, i).applyMatrix4(mat);
        const proj = v.dot(axis);
        if (proj < minProj) { minProj = proj; minPt.copy(v); }
        if (proj > maxProj) { maxProj = proj; maxPt.copy(v); }
    }
    return { width: maxProj - minProj, minPt, maxPt, axis };
}

function addEndCap(point, axis, color) {
    const perp = Math.abs(axis.dot(new THREE.Vector3(1, 0, 0))) > 0.9
        ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
    const side = new THREE.Vector3().crossVectors(axis, perp).normalize();
    const r = getMarkerRadius() * 3;
    addMeasureLine(point.clone().addScaledVector(side, -r),
                   point.clone().addScaledVector(side,  r), color);
}

// ── UI helpers ────────────────────────────────────────────────────────────────

function updatePointCountUI() {
    const cfg = MODE_CONFIG[measurementMode];
    document.getElementById('point-count').textContent = selectedPoints.length;
    document.getElementById('point-total').textContent = cfg.required > 0 ? cfg.required : '∞';
}

function showResult(valueStr, label) {
    document.getElementById('result-label').textContent = label + ':';
    document.getElementById('distance-value').textContent = valueStr;
    document.getElementById('measurement-display').classList.remove('hidden');
    document.getElementById('no-measurement').classList.add('hidden');
}

function clearMeasurement() {
    selectedPoints = [];
    pointMarkers.forEach(o => scene.remove(o));   pointMarkers = [];
    measureVisuals.forEach(o => scene.remove(o)); measureVisuals = [];
    measurementPlane = null;
    if (planeVisual) { scene.remove(planeVisual); planeVisual = null; }
    updatePointCountUI();
    document.getElementById('measurement-display').classList.add('hidden');
    document.getElementById('no-measurement').classList.remove('hidden');
}

function resetView() {
    if (!mesh) return;
    const bbox   = new THREE.Box3().setFromObject(mesh);
    const center = bbox.getCenter(new THREE.Vector3());
    const size   = bbox.getSize(new THREE.Vector3());
    const dist   = Math.max(size.x, size.y, size.z) / 2 / Math.tan(camera.fov * Math.PI / 360) * 1.5;
    camera.position.set(center.x, center.y, center.z + dist);
    camera.lookAt(center);
    controls.target.copy(center);
    controls.update();
}

function showLoading(show) {
    document.getElementById('loading-message').classList.toggle('hidden', !show);
}

function onWindowResize() {
    const canvas = document.getElementById('canvas');
    camera.aspect = canvas.clientWidth / canvas.clientHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(canvas.clientWidth, canvas.clientHeight);
}

function animate() {
    requestAnimationFrame(animate);
    controls.update();
    renderer.render(scene, camera);
}

window.addEventListener('DOMContentLoaded', init);
