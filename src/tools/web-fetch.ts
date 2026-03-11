import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import type { ToolDefinition } from "../providers/types.js";
import { formatError } from "../ui/format.js";

export function createWebFetchTool(): ToolDefinition {
  return {
    name: "web_fetch",
    description:
      "Fetch a URL and return the page content as readable text. Handles HTML (extracts article content), PDFs (extracts text), and plain text. Use this to read documentation, papers, blog posts, or any web page.",
    parameters: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "URL to fetch",
        },
        max_length: {
          type: "number",
          description: "Max characters to return (default: 20000)",
        },
      },
      required: ["url"],
    },
    execute: async (args) => {
      const url = args.url as string;
      const maxLength = (args.max_length as number) ?? 20000;

      try {
        const resp = await fetch(url, {
          headers: {
            "User-Agent": "Helios-ML-Agent/1.0",
            Accept: "text/html,application/xhtml+xml,application/pdf,text/plain,application/json",
          },
          redirect: "follow",
          signal: AbortSignal.timeout(30_000),
        });

        if (!resp.ok) {
          return JSON.stringify({ error: `HTTP ${resp.status}: ${resp.statusText}` });
        }

        const contentType = resp.headers.get("content-type") ?? "";
        let title: string | undefined;
        let text: string;

        if (contentType.includes("application/pdf") || url.endsWith(".pdf")) {
          const buffer = new Uint8Array(await resp.arrayBuffer());
          const { extractText } = await import("unpdf");
          const result = await extractText(buffer);
          text = Array.isArray(result.text) ? result.text.join("\n") : result.text;
        } else if (contentType.includes("text/html") || contentType.includes("xhtml")) {
          const html = await resp.text();
          const parsed = extractArticle(html, url);
          title = parsed.title;
          text = parsed.text;
        } else {
          text = await resp.text();
        }

        const truncated = text.length > maxLength;
        const content = truncated ? text.slice(0, maxLength) : text;

        return JSON.stringify({
          url,
          title,
          content_type: contentType.split(";")[0],
          length: text.length,
          truncated,
          content,
        });
      } catch (err) {
        return JSON.stringify({
          error: formatError(err),
        });
      }
    },
  };
}

function extractArticle(html: string, url: string): { title?: string; text: string } {
  const { document } = parseHTML(html);
  const reader = new Readability(document as any);
  const article = reader.parse();

  if (article?.textContent) {
    // Clean up readability output — collapse excessive whitespace
    const text = article.textContent
      .split("\n")
      .map((line: string) => line.trim())
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();

    return { title: article.title ?? undefined, text };
  }

  // Fallback: basic tag stripping if readability can't extract
  return { text: fallbackHtmlToText(html) };
}

function fallbackHtmlToText(html: string): string {
  let text = html;
  text = text.replace(/<script[\s\S]*?<\/script>/gi, "");
  text = text.replace(/<style[\s\S]*?<\/style>/gi, "");
  text = text.replace(/<head[\s\S]*?<\/head>/gi, "");
  text = text.replace(/<!--[\s\S]*?-->/g, "");
  text = text.replace(/<\/(p|div|h[1-6]|li|tr|blockquote|pre|section|article)>/gi, "\n");
  text = text.replace(/<br\s*\/?>/gi, "\n");
  text = text.replace(/<[^>]+>/g, "");
  text = text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, " ");
  text = text
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n");
  return text.trim();
}
