# MaleCNS connectome bundle (public/connectome/)

Source: **MaleCNS v1.0** (Janelia/HHMI + Google, male adult Drosophila CNS connectome)
- Downloaded from the "Fruit Fly Simulation" Hugging Face Space by Xenova
  (https://huggingface.co/spaces/Xenova/fruit-fly-simulation), which repackages
  the official flat-connectome files from https://male-cns.janelia.org/download/
- License: **CC BY 4.0** (MaleCNS dataset). The reference application code
  (`src/brain.js` LIF model etc.) is MIT-licensed by that space's author; our
  TypeScript port keeps the attribution comments in
  `src/lib/connectome/lif.ts`.

Contents (identical to the space's `public/data/`):
- `manifest.json` — array inventory, checksums, dataset provenance
- `neurons.json.gz` — 166,700 neurons: `[bodyId, type, superclass, side, neurotransmitter, sign, [x,y,z] | null]`
- `offsets-000.bin.gz` — CSR row pointers, Uint32, length 166,701 (target-major)
- `sources-XXX.bin.gz` (13 parts) — edge source indices, Uint32, 25,582,938 total
- `counts-XXX.bin.gz` (13 parts) — per-edge synapse counts, Uint32, 25,582,938 total

Decompression: the app uses `DecompressionStream('gzip')` client-side; serve the
`.bin.gz` files as stored bytes (no `Content-Encoding: gzip` header — that would
double-decompress and corrupt them).

Verified pathway facts (extracted 2026-09-27, see worklog Round 14):
- Kenyon cells (type `KC*`): 4,064
- MBONs (type `MBON*`): 97
- Dopamine neurons: 392 (PAM* cluster: 316 reward; PPL1/PPL2* clusters: 24 punishment)
- KC→MBON edges: 61,210 (463,640 synapses) — the real plastic pathway
- DAN→KC edges: 129,113; DAN→MBON edges: 3,160
- LC4→readout-DN direct edges: 126; LC9: 172; LPLC2: 214; MBON→readout-DN: 39
- Readout DN L/R pairs (index in neurons.json): DNa02 (R 332 / L 131957),
  DNp09 (L 725 / R 1087), DNg100 (L 36 / R 46), DNg97 (L 3548 / R 122339),
  DNa11 (L 898 / R 1142), DNg13 (L 993 / R 125880), MDN (R 706 / L 1196 / R 1240 / L 2194),
  DNp01 (R 0 / L 6)
- Visual interface candidates (with L/R side + position for receptive-field binning):
  LC4 (126), LC9 (219), LC6 (124), LC11 (143), LC12 (498), LC13 (177), LC15 (126),
  LC16 (182), LC17 (353), LC18 (208), LC21 (153), LPLC1 (134), LPLC2 (185)
