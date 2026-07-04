# 3D STL Measurer

A web-based application for loading and measuring distances on 3D STL mesh files.

## Features

- Load binary and ASCII STL files
- Interactive 3D viewer with rotation, pan, and zoom controls
- Click to select two points on the mesh
- Automatic distance calculation in millimeters
- Real-time visualization of measurement points and line
- Clean, intuitive UI

## Getting Started

### Quick Start

1. Open `index.html` in a web browser
2. Click "Load STL File" and select an STL file from your computer
3. The mesh will load and be centered in the viewport
4. Click on two points on the mesh to measure the distance between them
5. The distance in millimeters will be displayed in the sidebar

### Controls

- **Rotate**: Left click + drag on the mesh
- **Pan**: Right click + drag
- **Zoom**: Scroll wheel
- **Select Point**: Left click on the mesh surface (while not rotating/panning)
- **Clear Points**: Click "Clear Points" button to start a new measurement
- **Reset View**: Click "Reset View" to fit the model in the viewport

## How It Works

1. **File Loading**: Supports both binary and ASCII STL file formats
2. **Geometry Processing**: 
   - Automatically centers the mesh at the origin
   - Scales the model to fit nicely in the viewport
   - Computes vertex normals for proper lighting
3. **Point Selection**: Uses raycasting to detect clicks on the mesh surface
4. **Distance Calculation**: Measures Euclidean distance between the two selected points

## Files

- `index.html` - Main HTML structure
- `styles.css` - Styling and layout
- `app.js` - Three.js scene setup and measurement logic
- `README.md` - This file

## Dependencies

- [Three.js](https://threejs.org/) - 3D graphics library (loaded from CDN)
- [OrbitControls](https://threejs.org/examples/#controls/OrbitControls) - Camera control (loaded from CDN)

## Browser Support

Works on all modern browsers that support:
- WebGL
- ES6 JavaScript
- File API

## Tips

- Use the right mouse button to pan around the model
- Use the scroll wheel to zoom in for precise point selection
- Click "Clear Points" to reset and start a new measurement
- Results are reported in the file's native units (mm for typical STLs): the
  viewer scales the model to fit the viewport, but measurements divide that
  display scale back out
