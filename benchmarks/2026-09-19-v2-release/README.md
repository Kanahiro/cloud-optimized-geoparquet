# v2.0.0 data release verification

This release merges upstream `3541e4f` into the quantized-overview branch (`c187fb8`) and updates the writer, readers, demo, and sample URLs to version 2.0.0. `SPEC.md` is the upstream versionless `geo.lod` specification; `OVERVIEWS.md` defines the optional rendering payload.

The four sample datasets are reconverted using the release binary and defaults recorded in `build-provenance.json`. Original columns, geometry WKB, row counts and row multiplicities are checked against the source. For the three large datasets, sorted SHA-256 row digests from the prior source verification are reused only after a fresh whole-file SHA-256 match. Administrative boundaries are compared with newly computed digests in small Arrow batches. Digest matching is a cryptographic check, not a byte-for-byte comparison of the reordered Parquet files.

Each `*.verified.json` records source/output hashes, bytes, layout levels and the intended public URL. A verified file is ready for upload; this alone does not establish publication. Public upload and HTTP verification evidence is recorded separately when completed.

`*.local-smoke.json` checks coarse and finest prefix reads, decoded geometry, and absence of primary WKB reads when rendering overviews are available. These samples stop after ten returned features, but reader batching may fetch more data. Timings are diagnostic observations on a busy local machine, not a benchmark comparison. Conversion elapsed times also include system scheduling or sleep and must not be interpreted as steady-state throughput.

Automated validation: 90 Rust tests and 53 JS/demo tests passed, Clippy passed with warnings denied, and the demo production build passed. Browser rendering was checked against a local HTTP Range server. No claim is made about browser memory, first-paint latency, or GPU performance.
