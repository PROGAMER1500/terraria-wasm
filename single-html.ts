import { readFile, readdir, writeFile } from "node:fs/promises";
import { extname, posix, relative, resolve } from "node:path";
import type { Plugin } from "vite";

const mimeTypes: Record<string, string> = {
	".css": "text/css",
	".gif": "image/gif",
	".html": "text/html",
	".ico": "image/x-icon",
	".jpeg": "image/jpeg",
	".jpg": "image/jpeg",
	".js": "text/javascript",
	".json": "application/json",
	".otf": "font/otf",
	".png": "image/png",
	".svg": "image/svg+xml",
	".ttf": "font/ttf",
	".wasm": "application/wasm",
	".webp": "image/webp",
	".woff": "font/woff",
	".woff2": "font/woff2",
};

type EmbeddedFile = {
	data: string;
	type: string;
};

async function listFiles(directory: string): Promise<string[]> {
	const entries = await readdir(directory, { withFileTypes: true });
	const files = await Promise.all(
		entries.map(async (entry) => {
			const path = resolve(directory, entry.name);
			return entry.isDirectory() ? listFiles(path) : [path];
		})
	);
	return files.flat();
}

function embeddedRuntime(): string {
	return String.raw`
const embeddedFiles = JSON.parse(document.getElementById("embedded-files").textContent);
const byteCache = new Map();
const moduleUrls = new Map();
const modulesLoading = new Set();
const normalize = (path) => path.replace(/^\/+/, "").replace(/\\/g, "/");
const getBytes = (path) => {
	path = normalize(path);
	if (/\.(js|css)$/i.test(path) && byteCache.has(path)) return byteCache.get(path);
	const encoded = embeddedFiles[path];
	if (!encoded) throw new Error("Missing embedded build file: " + path);
	const binary = atob(encoded.data);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	if (/\.(js|css)$/i.test(path)) byteCache.set(path, bytes);
	return bytes;
};
const dataUrl = (path) => {
	path = normalize(path);
	const file = embeddedFiles[path];
	if (!file) return null;
	return "data:" + file.type + ";base64," + file.data;
};
const nativeFetch = window.fetch.bind(window);
window.fetch = (input, init) => {
	const requestUrl = input instanceof Request ? input.url : input;
	const requestMethod = init?.method || (input instanceof Request ? input.method : "GET");
	if (requestMethod === "GET") {
		const path = normalize(new URL(requestUrl, location.href).pathname);
		if (embeddedFiles[path]) {
			return Promise.resolve(new Response(getBytes(path), {
				status: 200,
				headers: { "Content-Type": embeddedFiles[path].type }
			}));
		}
	}
	return nativeFetch(input, init);
};
const modulePattern = /\b(?:import|export)\s+(?:[^'"]*?\s+from\s*)?["'](\.{1,2}\/[^'"]+\.js(?:\?[^'"]*)?)["']|\bimport\s*\(\s*["'](\.{1,2}\/[^'"]+\.js(?:\?[^'"]*)?)["']\s*\)/g;
async function embeddedModule(path) {
	path = normalize(path);
	if (moduleUrls.has(path)) return moduleUrls.get(path);
	if (modulesLoading.has(path)) throw new Error("Circular embedded module import: " + path);
	const file = embeddedFiles[path];
	if (!file || !path.endsWith(".js")) throw new Error("Missing embedded JavaScript module: " + path);
	modulesLoading.add(path);
	let source = new TextDecoder().decode(getBytes(path));
	source = source.replace(/\bimport\.meta\.url\b/g, '(new URL("/' + path + '", location.href)).href');
	source = source.replace(/import\(\s*["'](\/_framework\/[^"']+\.js)["']\s*\)/g, (_, specifier) =>
		'(async()=>import(await globalThis.__embeddedModuleUrl("' + normalize(specifier) + '")))()'
	);
	for (const assetPath of Object.keys(embeddedFiles)) {
		if (assetPath.startsWith("_framework/") || /\.(js|css)$/i.test(assetPath)) continue;
		const url = dataUrl(assetPath);
		source = source.split("./" + assetPath).join(url);
		source = source.split("/" + assetPath).join(url);
	}
	const imports = [...source.matchAll(modulePattern)];
	for (const match of imports.reverse()) {
		const specifier = match[1] || match[2];
		const childPath = normalize(new URL(specifier, "https://embedded.invalid/" + path).pathname);
		const childUrl = await embeddedModule(childPath);
		const replacement = match[0].replace(specifier, childUrl);
		source = source.slice(0, match.index) + replacement + source.slice(match.index + match[0].length);
	}
	modulesLoading.delete(path);
	const url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
	moduleUrls.set(path, url);
	return url;
}
globalThis.__embeddedModuleUrl = embeddedModule;
`;
}

export function singleHtmlPlugin(): Plugin {
	let outputDirectory = "";

	return {
		name: "single-html",
		apply: "build",
		configResolved(config) {
			outputDirectory = resolve(config.root, config.build.outDir);
		},
		async closeBundle() {
			const htmlPath = resolve(outputDirectory, "index.html");
			let html = await readFile(htmlPath, "utf8");
			const allFiles = await listFiles(outputDirectory);
			const files: Record<string, EmbeddedFile> = {};

			for (const filePath of allFiles) {
				const path = relative(outputDirectory, filePath).split("\\").join("/");
				if (path === "index.html" || path === "index.single.html") continue;
				const bytes = await readFile(filePath);
				const extension = extname(path).toLowerCase();
				files[path] = {
					data: bytes.toString("base64"),
					type: mimeTypes[extension] || "application/octet-stream",
				};
			}

			const toDataUrl = (path: string) => {
				const file = files[path];
				return file ? `data:${file.type};base64,${file.data}` : null;
			};
			const normalize = (url: string, base = "") =>
				posix
					.normalize(posix.join(base, url))
					.replace(/^\/+/, "")
					.replace(/^\.\//, "");

			html = html.replace(
				/<link\b[^>]*\brel=["']stylesheet["'][^>]*\bhref=["']([^"']+)["'][^>]*>|<link\b[^>]*\bhref=["']([^"']+)["'][^>]*\brel=["']stylesheet["'][^>]*>/gi,
				(link, hrefA: string, hrefB: string) => {
					const path = normalize(hrefA || hrefB);
					if (!files[path]) return link;

					let css = Buffer.from(files[path].data, "base64").toString("utf8");
					css = css.replace(
						/url\(\s*(["']?)([^"' )]+)\1\s*\)/g,
						(all, quote: string, ref: string) => {
							if (/^(data:|https?:|blob:|#)/.test(ref)) return all;
							const assetPath = normalize(
								ref,
								ref.startsWith("/") ? "" : posix.dirname(path)
							);
							const url = toDataUrl(assetPath);
							return url ? `url(${quote}${url}${quote})` : all;
						}
					);
					return `<style>${css.replace(/<\/style/gi, "<\\/style")}</style>`;
				}
			);

			const staticFiles = Object.keys(files)
				.filter(
					(path) =>
						!path.endsWith(".js") &&
						!path.endsWith(".css") &&
						!path.startsWith("_framework/")
				)
				.sort((a, b) => b.length - a.length);

			const entryScripts: string[] = [];
			html = html.replace(
				/<script\b[^>]*\bsrc=["']([^"']+)["'][^>]*>\s*<\/script>/gi,
				(script, src: string) => {
					const path = normalize(src);
					if (!files[path] || !path.endsWith(".js")) return script;
					entryScripts.push(path);
					return "";
				}
			);

			html = html.replace(
				/<link\b[^>]*\bhref=["']([^"']+)["'][^>]*>/gi,
				(link, href: string) => {
					const path = normalize(href);
					const url = toDataUrl(path);
					return url ? link.replace(href, url) : link;
				}
			);

			for (const path of staticFiles) {
				const url = toDataUrl(path)!;
				for (const reference of ["./" + path, "/" + path]) {
					html = html.split(reference).join(url);
				}
			}

			const assetJson = JSON.stringify(files).replace(/</g, "\\u003c");
			const bootstrap =
				`<script id="embedded-files" type="application/json">${assetJson}</script>` +
				`<script type="module">${embeddedRuntime()}${entryScripts
					.map(
						(path) =>
							`await globalThis.__embeddedModuleUrl(${JSON.stringify(path)}).then((url) => import(url));`
					)
					.join("\n")}</script>`;
			html = html.replace("</head>", `${bootstrap}</head>`);
			await writeFile(resolve(outputDirectory, "index.single.html"), html);
		},
	};
}
