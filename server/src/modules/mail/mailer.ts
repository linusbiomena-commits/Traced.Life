import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { renderTemplate, type Locale, type TemplateName } from './templates.ts';

export type MailAttachment = { filename: string; contentType: string; content: Buffer; contentId?: string };

export type MailMessage = {
  to: string;
  template: TemplateName;
  locale: Locale;
  data: Record<string, string>;
  attachments?: MailAttachment[];
  /** Passed to the provider so a retried send is never delivered twice. */
  idempotencyKey?: string;
};

export type SendResult = { provider: string; messageId: string | null };

export type SentMail = MailMessage & { subject: string; text: string; html: string; sentAt: Date };

export interface Mailer {
  send(message: MailMessage): Promise<SendResult>;
}

/** A failed send. `retryable` is false for permanent errors (bad address, rejected content). */
export class MailSendError extends Error {
  constructor(message: string, readonly retryable: boolean) {
    super(message);
    this.name = 'MailSendError';
  }
}

/** Keeps messages in memory. Used by tests; `failNext` simulates provider outages. */
export class MemoryMailer implements Mailer {
  readonly sent: SentMail[] = [];
  failNext = 0;
  async send(message: MailMessage): Promise<SendResult> {
    if (this.failNext > 0) {
      this.failNext--;
      throw new MailSendError('simulated provider outage', true);
    }
    this.sent.push({ ...message, ...renderTemplate(message.template, message.locale, message.data), sentAt: new Date() });
    return { provider: 'memory', messageId: randomUUID() };
  }
  lastTo(to: string, template?: TemplateName): SentMail | undefined {
    return this.sent.filter((m) => m.to === to && (!template || m.template === template)).at(-1);
  }
}

/**
 * Local development: writes each email to .dev-mail/ (HTML preview with inline images embedded,
 * plain text, and attachments) and prints the subject and link. Sends nothing.
 */
export class DevFileMailer implements Mailer {
  constructor(private readonly dir: string) {}
  async send(message: MailMessage): Promise<SendResult> {
    const rendered = renderTemplate(message.template, message.locale, message.data);
    await mkdir(this.dir, { recursive: true });
    const id = randomUUID();
    const base = `${new Date().toISOString().replace(/[:.]/g, '-')}-${message.template}-${id.slice(0, 8)}`;
    let preview = rendered.html;
    for (const a of message.attachments ?? []) {
      if (a.contentId) preview = preview.split(`cid:${a.contentId}`).join(`data:${a.contentType};base64,${a.content.toString('base64')}`);
      await writeFile(path.join(this.dir, `${base}-${a.filename}`), a.content);
    }
    await writeFile(path.join(this.dir, `${base}.html`), preview, 'utf8');
    await writeFile(path.join(this.dir, `${base}.txt`), `To: ${message.to}\nSubject: ${rendered.subject}\n\n${rendered.text}\n`, 'utf8');
    console.log(`[dev-mail] ${message.template} -> ${message.to}${message.data.link ? `\n           ${message.data.link}` : ''}`);
    return { provider: 'dev-file', messageId: id };
  }
}

/**
 * Resend (https://resend.com) over its REST API; no SDK. Requires a verified sending domain and
 * an API key, neither of which is configured yet (needs approval). Note: Resend stores account
 * data, logs and email metadata in the United States regardless of sending region.
 */
export class ResendMailer implements Mailer {
  constructor(
    private readonly apiKey: string,
    private readonly from: string,
    private readonly replyTo?: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async send(message: MailMessage): Promise<SendResult> {
    const rendered = renderTemplate(message.template, message.locale, message.data);
    const body = {
      from: this.from,
      to: [message.to],
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
      ...(this.replyTo ? { reply_to: this.replyTo } : {}),
      tags: [{ name: 'kind', value: message.template }],
      ...(message.attachments?.length
        ? { attachments: message.attachments.map((a) => ({ filename: a.filename, content: a.content.toString('base64'), content_type: a.contentType, ...(a.contentId ? { content_id: a.contentId } : {}) })) }
        : {}),
    };
    let res: Response;
    try {
      res = await this.fetchImpl('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
          'User-Agent': 'traced-platform/0.3',
          ...(message.idempotencyKey ? { 'Idempotency-Key': message.idempotencyKey } : {}),
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      throw new MailSendError(`network error: ${(err as Error).name}`, true);
    }
    const json = (await res.json().catch(() => ({}))) as { id?: string; name?: string };
    if (!res.ok) {
      // 429 and 5xx are temporary; other 4xx (invalid address, unverified domain...) are not.
      throw new MailSendError(`resend ${res.status} ${json.name ?? ''}`.trim(), res.status === 429 || res.status >= 500);
    }
    return { provider: 'resend', messageId: json.id ?? null };
  }
}

export function createMailer(opts: { transport: 'dev' | 'memory' | 'resend'; devDir: string; resendApiKey?: string; mailFrom?: string; replyTo?: string }): Mailer {
  if (opts.transport === 'memory') return new MemoryMailer();
  if (opts.transport === 'resend') {
    if (!opts.resendApiKey || !opts.mailFrom) throw new Error('RESEND_API_KEY and MAIL_FROM are required for MAIL_TRANSPORT=resend');
    return new ResendMailer(opts.resendApiKey, opts.mailFrom, opts.replyTo);
  }
  return new DevFileMailer(opts.devDir);
}
