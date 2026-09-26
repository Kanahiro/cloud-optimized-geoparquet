# Vendored hyparquet

Source: https://github.com/Kanahiro/hyparquet (fork of https://github.com/hyparam/hyparquet)
Commit: 9365a88f34a0816b9a77e08c176ca0c480d3524c (based on upstream 23a36d8, package version 1.31.1)
License: MIT; see LICENSE.

The source JavaScript is unchanged from the fork commit. The fork adds column
views (`onColumnView` in `parquetRead`, `readColumnView` in `parquetScan`),
which expose decoded leaf values with definition and repetition levels before
nested list assembly. Generated declarations (`npm run build:types`) are
colocated with JavaScript to make the bundled code usable from TypeScript
without installation hooks. This snapshot is shipped in the cogp npm package:
consumers do not need GitHub access or a dependency build.

COGP uses the page planning interfaces in src/plan.js, including
pageRangesByGroup and pageLocationsByGroup, and reads `quantized_geoarrow`
overviews through `onColumnView`. Keep this source and its declarations
together when upgrading. Run reader, page index, HTTP range, and package smoke
tests after an update. Replace the snapshot with a registry dependency once the
required interfaces have a supported public contract.
