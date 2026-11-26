// The browser's entry (scripts/build.ts writes it as the page's one <script type="module">, which
// runs once the HTML is parsed and never holds up its first paint): Solid takes over the page the
// build rendered, without rendering it again (the body is the application's island; Document.tsx),
// and from then on Solid Router does the navigation (src/app.tsx).
import { hydrate } from "@solidjs/web";
import { App } from "./app";

hydrate(() => <App />, document.body);
