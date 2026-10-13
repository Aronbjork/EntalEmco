# Compact 5 CAM

A small browser app for programming an **Emco Compact 5 CNC** lathe: draw a 2D half-profile (or import a DXF), add turning operations, preview the toolpath, and send the program to the lathe over the RS232 cable, or save it as a `.CNC` file for Mike's Free Interface.

No install and no build step: open `index.html` in Chrome or Edge (Web Serial is needed for the direct transfer; everything else works in any modern browser).

## Features

- Profile editor on a canvas with grid snap, drag, fillet and chamfer, and a point table with lines and arcs (G02 / G03).
- DXF import (LINE, ARC, CIRCLE, LWPOLYLINE, POLYLINE, SPLINE as lines). The drawing is mapped onto the lathe axes automatically and can be adjusted in the import dialog.
- Operations: facing, rough turning (collision-aware Z passes with 45° pull-out), finish contour, groove, parting off, centre drilling with pecking, thread (G33), tool change, custom blocks.
- Program output in the exact column layout the Compact 5 and Mike's Free Interface use (X as diameter in 1/100 mm, arcs as G02/G03 + `M99 I K`, split at quadrant boundaries). Mk1/Mk2 and Mk3/Mk4 controllers are both supported.
- Backplot / simulation of the generated program, or of any `.CNC` file you open.
- Serial transfer with adjustable baud rate, data bits, stop bits, parity, handshake, line endings and delays (defaults: 300 baud, 8N1, no handshake). Incoming data from the lathe is shown and can be loaded as a program.
- Projects are kept in the browser and can be saved / opened as JSON files.

## Files

| Path | What it is |
|------|------------|
| `index.html`, `style.css` | UI shell and styling |
| `js/geom.js` | arcs, envelope, fillet / chamfer geometry |
| `js/dxf.js` | DXF reader, axis mapping and chaining |
| `js/cam.js` | operations → Emco blocks |
| `js/emco.js` | Emco block formatting, parsing and simulation |
| `js/serial.js` | Web Serial transport |
| `js/app.js` | the application |

## Lathe side

1. Park the tool at the program start position (default Ø27.00 / Z+1.00 for Ø25 stock) and zero X on the stock surface, Z on the part face.
2. Put the lathe in CNC mode and in RS232 receive mode: `G66` `INP` `INP`, display shows `A LO`, press `START`.
3. Click **Send program** in the app.

The thread (G33) and tool change (M06 / G26) block layouts have not been verified on a real machine yet. Receive a program from the lathe that uses them and compare before relying on them.
