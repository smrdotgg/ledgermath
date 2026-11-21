/**
 * Each kind of file's schema in the data API's tree: its name in the tree
 * (v1/schemas/<name>.schema.json), and where it is kept in this repository.
 * scripts/lib/api.ts, the build, writes exactly these and re-exports this
 * list; infra/runs/api-bucket.ts takes the names served from it, so the edge
 * serves no schema the build does not write.
 *
 * In a module of its own, with no import, because the stack (infra/runs/)
 * imports it, and SST bundles the stack to run under Node: scripts/lib/api.ts
 * brings in methods/run.ts, which reads Bun's import.meta.dir as it loads.
 */
export const API_SCHEMAS = [
	{ name: "index", describes: "v1/index.json", source: "schemas/api/v1/index.schema.json" },
	{ name: "series-list", describes: "v1/series.json", source: "schemas/api/v1/series-list.schema.json" },
	{ name: "series", describes: "v1/series/<id>.json", source: "schemas/api/v1/series.schema.json" },
	{ name: "series-month", describes: "v1/series/<id>/<yyyy-mm>.json", source: "schemas/api/v1/series-month.schema.json" },
	{ name: "prices", describes: "v1/prices/<yyyy-mm-dd>.json", source: "schemas/prices.schema.json" },
] as const;
