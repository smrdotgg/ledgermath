/**
 * One plain-text message to the maintainer on Telegram, for the alarm
 * (scripts/alarm.ts; ADR-0033). A much smaller cousin of the maintainer's own
 * telegram-notify: one POST of the form fields chat_id and text to the Bot
 * API's sendMessage, with no parse_mode, no attachments and no second try.
 *
 * The alarm reaches Telegram through Messenger, as it reaches GitHub through
 * IssueTracker, so tests use a fake or a stand-in server. TelegramBot never
 * throws and gives up after its budget. What happened is one of a closed set
 * of outcomes (SendOutcome), said in fixed words (outcomeWords): of Telegram's
 * answer only the HTTP status is kept. The request's address holds the bot
 * token, so it is never put in an error, a log line or an outcome.
 */

/** Where the Bot API is: the tests give a stand-in instead. */
export const TELEGRAM_API = "https://api.telegram.org";
/** Telegram refuses a message whose text is longer than this. */
export const MAX_MESSAGE_CHARS = 4_096;
/** The whole request, its answer included, is given up after this: the time the maintainer's own tool waits. */
export const SEND_BUDGET_MS = 15_000;
/** The most of an answer read. sendMessage's answer repeats the message, which is under a kilobyte. */
export const ANSWER_BYTES = 65_536;

/** What came of one message: data only, never Telegram's words. */
export type SendOutcome =
	/** Telegram answered 2xx with JSON whose ok is true. */
	| { kind: "sent" }
	/** No whole answer within the budget. */
	| { kind: "timeout" }
	/** No answer at all: the connection was refused or broke. */
	| { kind: "no-answer" }
	/** An answer other than 2xx (401 a wrong token, 429 too many requests, and so on). A redirect is not followed. */
	| { kind: "status"; status: number }
	/** A 2xx answer that is not JSON, or longer than ANSWER_BYTES. */
	| { kind: "malformed" }
	/** A 2xx answer in JSON whose ok is not true. */
	| { kind: "not-accepted" };

/** The fixed words for an outcome that is not "sent". */
export function outcomeWords(outcome: Exclude<SendOutcome, { kind: "sent" }>, budgetMs = SEND_BUDGET_MS): string {
	switch (outcome.kind) {
		case "timeout":
			return `Telegram gave no whole answer within ${budgetMs / 1_000} s`;
		case "no-answer":
			return "Telegram could not be reached";
		case "status":
			return `Telegram answered HTTP ${Number.isInteger(outcome.status) ? outcome.status : "with no valid status"}`;
		case "malformed":
			return "Telegram's answer was not understood";
		case "not-accepted":
			return "Telegram did not accept the message";
	}
}

/** Sends one message. Never throws; says what happened from a closed set. */
export interface Messenger {
	send(text: string): Promise<SendOutcome>;
}

/** A bot token: digits, a colon, then letters, digits, _ and -. Nothing in it can change the request's address. */
const TOKEN_SHAPE = /^[0-9]{1,20}:[A-Za-z0-9_-]{1,200}$/;

/** The names of the two secrets, as the workflow's alarm step passes them. */
export const TELEGRAM_VARIABLES = ["TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID"] as const;

type Fetch = (url: string, init: RequestInit) => Promise<Response>;

export interface BotOptions {
	/** TELEGRAM_API unless given. */
	apiBase?: string;
	/** SEND_BUDGET_MS unless given (tests give less). */
	budgetMs?: number;
	fetcher?: Fetch;
}

/** The Bot API's sendMessage, with a token and a chat. */
export class TelegramBot implements Messenger {
	readonly budgetMs: number;

	constructor(
		private readonly token: string,
		private readonly chatId: string,
		private readonly options: BotOptions = {},
	) {
		// The message never repeats the token.
		if (!TOKEN_SHAPE.test(token)) throw new Error("the bot token is not shaped like one");
		this.budgetMs = options.budgetMs ?? SEND_BUDGET_MS;
	}

	async send(text: string): Promise<SendOutcome> {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), this.budgetMs);
		const started = performance.now();
		try {
			let response: Response;
			try {
				response = await (this.options.fetcher ?? fetch)(`${this.options.apiBase ?? TELEGRAM_API}/bot${this.token}/sendMessage`, {
					method: "POST",
					body: new URLSearchParams({ chat_id: this.chatId, text }),
					signal: controller.signal,
					// A redirect would carry the form elsewhere: its status is the outcome.
					redirect: "manual",
				});
			} catch {
				// Never the error itself: Bun's names the address, and the address holds the token.
				return controller.signal.aborted ? { kind: "timeout" } : { kind: "no-answer" };
			}
			if (!response.ok) {
				response.body?.cancel().catch(() => undefined);
				return { kind: "status", status: response.status };
			}
			const answer = await readAnswer(response.body, this.budgetMs - (performance.now() - started), controller.signal);
			if (answer === "timeout") return { kind: "timeout" };
			if (answer === null) return { kind: "malformed" };
			let parsed: unknown;
			try {
				parsed = JSON.parse(answer);
			} catch {
				return { kind: "malformed" };
			}
			return typeof parsed === "object" && parsed !== null && (parsed as { ok?: unknown }).ok === true ? { kind: "sent" } : { kind: "not-accepted" };
		} catch {
			return controller.signal.aborted ? { kind: "timeout" } : { kind: "no-answer" };
		} finally {
			clearTimeout(timer);
		}
	}
}

/**
 * The whole answer as text, read for at most `ms`: "timeout" when it does not
 * end in time (or the request is aborted), null when it is longer than
 * ANSWER_BYTES or the connection breaks. Cancels what is left.
 */
async function readAnswer(stream: ReadableStream<Uint8Array> | null, ms: number, signal: AbortSignal): Promise<string | "timeout" | null> {
	if (stream === null) return "";
	const reader = stream.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const late = new Promise<"late">((resolve) => {
		timer = setTimeout(() => resolve("late"), Math.max(0, ms));
	});
	try {
		for (;;) {
			const read = await Promise.race([reader.read(), late]);
			if (read === "late") return "timeout";
			if (read.done) break;
			size += read.value.length;
			if (size > ANSWER_BYTES) return null;
			chunks.push(read.value);
		}
	} catch {
		return signal.aborted ? "timeout" : null;
	} finally {
		clearTimeout(timer);
		reader.cancel().catch(() => undefined);
	}
	return new TextDecoder().decode(Buffer.concat(chunks));
}

/** Whether a message can be sent, from the environment: a bot, or why not. */
export type TelegramSetup =
	| { kind: "ready"; messenger: Messenger }
	/** One or both of the secrets are unset or empty: a fork, or secrets never set. */
	| { kind: "absent"; missing: string[] }
	/** TELEGRAM_BOT_TOKEN is set, but not shaped like a bot token. */
	| { kind: "bad-token" };

/** The setup TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID give, from `env`. Reads nothing else of it. */
export function telegramFromEnvironment(env: Record<string, string | undefined>, options: BotOptions = {}): TelegramSetup {
	const missing = TELEGRAM_VARIABLES.filter((name) => (env[name] ?? "") === "");
	if (missing.length > 0) return { kind: "absent", missing };
	const token = env.TELEGRAM_BOT_TOKEN as string;
	if (!TOKEN_SHAPE.test(token)) return { kind: "bad-token" };
	return { kind: "ready", messenger: new TelegramBot(token, env.TELEGRAM_CHAT_ID as string, options) };
}
