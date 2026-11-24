/**
 * What a web ACL on the CloudFront Free flat-rate plan was seen to be allowed,
 * and a walk of a web ACL's rules that names everything else.
 *
 * The Free plan gates AWS WAF's features. A web ACL that uses a feature of Pro
 * or Business is "not eligible for this subscription tier", so the
 * subscription fails; and WAF refuses an update that adds such a feature to a
 * web ACL already on the plan (WAFFeatureNotIncludedInPricingPlanException,
 * naming the feature and the plan it needs). AWS's own table (CloudFront
 * Developer Guide, "flat-rate pricing plans") is coarse: Free allows 5 WAF
 * rules and "IP-based rate limiting"; header-based filtering, custom responses
 * and WAF logs need Pro; regex, challenges and Bot Control need Business. It
 * does not say that a string match needs Pro, and the first deploy of
 * production-runs (2026-11-24) failed on exactly that: the total rule's
 * scope-down was a byte match on the URI path.
 *
 * So what is listed here is what was seen accepted, on 2026-11-24, on a web
 * ACL subscribed to the Free plan in the development account (README, "The
 * public data API", "Seen on the first deploy"): the two AWS managed groups,
 * the per-address rate rule (aggregation IP), and the rate rule on all
 * requests together (aggregation CONSTANT) scoped down by an Or of a
 * geographic match and a Not of one. Refused there: a string match statement
 * and a size constraint statement, each "PRO". Anything else is refused by
 * this walk until it has been seen accepted the same way.
 *
 * Rules are taken as the provider takes them (camelCase, Pulumi's inputs):
 * webAclRules in infra/runs/public-blobs.ts, and the web ACL's inputs in the
 * resource graph (tests/public-api-graph.test.ts).
 */

/** AWS's table: a web ACL on the Free plan has at most 5 rules. Each managed group counts as one (4 rules were accepted, two of them groups of 3 and more rules each). */
export const FREE_PLAN_WAF_RULES = 5;

/** Each statement type seen accepted, with the only fields it was seen with. */
export const FREE_PLAN_STATEMENTS: Readonly<Record<string, readonly string[]>> = {
	managedRuleGroupStatement: ["vendorName", "name"],
	rateBasedStatement: ["limit", "aggregateKeyType", "evaluationWindowSec", "scopeDownStatement"],
	geoMatchStatement: ["countryCodes"],
	orStatement: ["statements"],
	notStatement: ["statements"],
};

/** The managed groups seen accepted, by name, all AWS's. */
export const FREE_PLAN_MANAGED_GROUPS: readonly string[] = ["AWSManagedRulesAmazonIpReputationList", "AWSManagedRulesKnownBadInputsRuleSet"];

/** The rate-based statement's aggregations seen accepted. FORWARDED_IP and CUSTOM_KEYS read headers or more than the address. */
export const FREE_PLAN_AGGREGATIONS: readonly string[] = ["IP", "CONSTANT"];

/** A rule's fields seen accepted. Labels, CAPTCHA and challenge settings were not. */
const RULE_FIELDS: readonly string[] = ["name", "priority", "action", "overrideAction", "statement", "visibilityConfig"];

type Fields = Record<string, unknown>;

function isFields(value: unknown): value is Fields {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Whether a value is `{ <key>: {} }` and nothing else: a plain block, or no override. */
function isBare(value: unknown, key: string): boolean {
	return isFields(value) && Object.keys(value).length === 1 && isFields(value[key]) && Object.keys(value[key]).length === 0;
}

function walk(statement: unknown, path: string, rule: string, refusals: string[]): void {
	if (!isFields(statement)) {
		refusals.push(`rule ${JSON.stringify(rule)}: ${path} is not a statement`);
		return;
	}
	const types = Object.keys(statement);
	if (types.length !== 1) refusals.push(`rule ${JSON.stringify(rule)}: ${path} has ${types.length} statement types (${types.join(", ")}), and a statement has one`);
	for (const type of types) {
		const at = `${path}.${type}`;
		const body = statement[type];
		const fields = FREE_PLAN_STATEMENTS[type];
		if (fields === undefined) refusals.push(`rule ${JSON.stringify(rule)}: ${at} is a statement of a type the CloudFront Free plan has not been seen to accept`);
		if (!isFields(body)) {
			refusals.push(`rule ${JSON.stringify(rule)}: ${at} has no fields`);
			continue;
		}
		if (fields !== undefined) {
			for (const field of Object.keys(body)) {
				if (!fields.includes(field)) refusals.push(`rule ${JSON.stringify(rule)}: ${at}.${field} is a field the CloudFront Free plan has not been seen to accept`);
			}
		}
		if (type === "managedRuleGroupStatement" && (body.vendorName !== "AWS" || !FREE_PLAN_MANAGED_GROUPS.includes(String(body.name)))) {
			refusals.push(
				`rule ${JSON.stringify(rule)}: ${at} names the group ${JSON.stringify(body.name)} of ${JSON.stringify(body.vendorName)}; the CloudFront Free plan has been seen to accept only AWS's ${FREE_PLAN_MANAGED_GROUPS.join(" and ")}`,
			);
		}
		if (type === "rateBasedStatement") {
			if (!FREE_PLAN_AGGREGATIONS.includes(String(body.aggregateKeyType))) {
				refusals.push(
					`rule ${JSON.stringify(rule)}: ${at} aggregates by ${JSON.stringify(body.aggregateKeyType)}; the CloudFront Free plan has been seen to accept ${FREE_PLAN_AGGREGATIONS.join(" and ")} only`,
				);
			}
		}
		// Whatever the type, the statements nested in it are walked too.
		if (body.scopeDownStatement !== undefined) walk(body.scopeDownStatement, `${at}.scopeDownStatement`, rule, refusals);
		if (body.statement !== undefined) walk(body.statement, `${at}.statement`, rule, refusals);
		if (body.statements !== undefined) {
			if (!Array.isArray(body.statements)) refusals.push(`rule ${JSON.stringify(rule)}: ${at}.statements is not a list`);
			else body.statements.forEach((nested, index) => walk(nested, `${at}.statements[${index}]`, rule, refusals));
		}
	}
}

/**
 * Everything in a web ACL's rules that the CloudFront Free plan has not been
 * seen to accept: more than 5 rules; a rule field, action or override other
 * than those seen; and, at any depth, a statement of a type, or with a field,
 * not listed above, a managed group other than the two, or an aggregation
 * other than IP and CONSTANT. Empty when all of it was seen accepted.
 */
export function freePlanRefusals(rules: readonly unknown[]): string[] {
	const refusals: string[] = [];
	if (rules.length > FREE_PLAN_WAF_RULES) refusals.push(`the web ACL has ${rules.length} rules, and the CloudFront Free plan allows ${FREE_PLAN_WAF_RULES}`);
	rules.forEach((rule, index) => {
		if (!isFields(rule)) {
			refusals.push(`rule ${index} is not a rule`);
			return;
		}
		const name = typeof rule.name === "string" ? rule.name : String(index);
		for (const field of Object.keys(rule)) {
			if (!RULE_FIELDS.includes(field)) refusals.push(`rule ${JSON.stringify(name)}: ${field} is a field the CloudFront Free plan has not been seen to accept`);
		}
		if (rule.action !== undefined && !isBare(rule.action, "block")) {
			refusals.push(`rule ${JSON.stringify(name)}: its action is ${JSON.stringify(rule.action)}; the CloudFront Free plan has been seen to accept a plain block only (a custom response needs Pro, a CAPTCHA or challenge Business)`);
		}
		if (rule.overrideAction !== undefined && !isBare(rule.overrideAction, "none")) {
			refusals.push(`rule ${JSON.stringify(name)}: its override is ${JSON.stringify(rule.overrideAction)}; the CloudFront Free plan has been seen to accept none only`);
		}
		walk(rule.statement, "statement", name, refusals);
	});
	return refusals;
}

/** The failure's message: what was refused, and what to do before a rule uses something new. */
export function freePlanMessage(refusals: readonly string[]): string {
	return [
		"The web ACL uses what the CloudFront Free plan has not been seen to accept:",
		...refusals.map((refusal) => `  - ${refusal}`),
		"The Free plan refuses a web ACL that uses a feature of Pro or Business: the subscription fails, or WAF refuses the update",
		'(on 2026-11-24 it refused the total rule\'s byte match on the URI path: "String match statement", PRO).',
		"A new statement type, field, managed group, aggregation or action must first be shown to be accepted: update a web ACL",
		"subscribed to the Free plan to use it (README, \"The public data API\", \"Seen on the first deploy\", says how it was done),",
		"then list it in tests/free-plan-waf.ts with what showed it.",
	].join("\n");
}
