import { TelegramFormatConverter } from '@chat-adapter/telegram';
import { describe, expect, it } from 'vitest';

import { linkifyBareUrls } from './telegram.js';

/**
 * A bare URL in a reply used to crash outbound delivery: the adapter autolinked
 * it into a MarkdownV2 link whose label was the URL text, and Telegram rejected
 * the message ("can't parse entities: Can't find end of a URL"). linkifyBareUrls
 * rewrites bare URLs to a scheme-less-label link and leaves everything else alone.
 */
describe('linkifyBareUrls', () => {
  const URL = 'http://127.0.0.1:10254/p/x/connections?connect=github&source=agent&n=A%20B';

  it('rewrites a bare URL as a scheme-less-label link', () => {
    expect(linkifyBareUrls(`Open: ${URL}`)).toBe(`Open: [${URL.replace(/^https?:\/\//, '')}](${URL})`);
  });

  it('leaves a URL already inside a [text](url) link', () => {
    const s = `[click](${URL})`;
    expect(linkifyBareUrls(s)).toBe(s);
  });

  it('leaves a URL inside an inline code span', () => {
    const s = `run \`curl ${URL}\``;
    expect(linkifyBareUrls(s)).toBe(s);
  });

  it('leaves a URL inside a fenced code block', () => {
    const s = `text\n\`\`\`\n${URL}\n\`\`\`\n`;
    expect(linkifyBareUrls(s)).toBe(s);
  });

  it('does not touch other markdown', () => {
    const s = '**bold** and _em_ and a list:\n- one\n- two';
    expect(linkifyBareUrls(s)).toBe(s);
  });

  it('produces MarkdownV2 whose link label is no longer a URL', () => {
    const rendered = new TelegramFormatConverter().fromMarkdown(linkifyBareUrls(`Open: ${URL}`));
    expect(rendered).not.toMatch(/\[https?/); // the broken form put the URL in the [label]
    expect(rendered).toContain(`](${URL})`);
  });
});
