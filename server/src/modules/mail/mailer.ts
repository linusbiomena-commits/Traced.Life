import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { renderTemplate, type Locale, type TemplateName } from './templates.ts';

export type MailMessage = {
  to: string;
  template: TemplateName;
  locale: Locale;
  data: Record<string, string>;
};

export type SentMail = MailMessage & { subject: string; text: string; html: string; sentAt: Date };

export interface Mailer {
  send(message: MailMessage): Promise<void>;
}

/** Keeps messages in memory. Used by tests. */
export class MemoryMailer implements Mailer {
  readonly sent: SentMail[] = [];
  async send(message: MailMessage): Promise<void> {
    this.sent.push({ ...message, ...renderTemplate(message.template, message.locale, message.data), sentAt: new Date() });
  }
  lastTo(to: string, template?: TemplateName): SentMail | undefined {
    return this.sent.filter((m) => m.to === to && (!template || m.template === template)).at(-1);
  }
}

/** Local development: writes each email to a file and prints the subject and link. Sends nothing. */
export class DevFileMailer implements Mailer {
  constructor(private readonly dir: string) {}
  async send(message: MailMessage): Promise<void> {
    const rendered = renderTemplate(message.template, message.locale, message.data);
    await mkdir(this.dir, { recursive: true });
    const base = `${new Date().toISOString().replace(/[:.]/g, '-')}-${message.template}-${randomUUID().slice(0, 8)}`;
    await writeFile(path.join(this.dir, `${base}.html`), rendered.html, 'utf8');
    await writeFile(path.join(this.dir, `${base}.txt`), `To: ${message.to}\nSubject: ${rendered.subject}\n\n${rendered.text}\n`, 'utf8');
    console.log(`[dev-mail] ${message.template} -> ${message.to}${message.data.link ? `\n           ${message.data.link}` : ''}`);
  }
}

export function createMailer(transport: 'dev' | 'memory', devDir: string): Mailer {
  return transport === 'memory' ? new MemoryMailer() : new DevFileMailer(devDir);
}
