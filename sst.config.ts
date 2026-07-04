/// <reference path="./.sst/platform/config.d.ts" />

export default $config({
	app(input) {
		return {
			name: "ledgermath",
			removal: input?.stage === "production" ? "retain" : "remove",
			protect: ["production"].includes(input?.stage),
			home: "aws",
			providers: {
				aws: {
					profile:
						input?.stage === "production" ? "tabot-production" : "tabot-dev",
				},
			},
		};
	},
	async run() {},
});
