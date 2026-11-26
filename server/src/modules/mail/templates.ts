// Branded TRACED emails in English and Arabic. Table-based HTML with inline styles for email
// clients; every dynamic value is HTML-escaped. Arabic copy needs professional review, and the
// collection instructions are PROVISIONAL until approved by the laboratory/management.
// Registration emails deliberately contain no patient name, date of birth or other patient data.

export type Locale = 'en' | 'ar';
export type TemplateName =
  | 'verify_email' | 'account_exists' | 'reset_password' | 'password_changed' | 'account_setup'
  | 'registration_confirmation' | 'registration_qr_resend';

export const SUPPORT_EMAIL = 'LinusBio@karama.tech';
export const SUPPORT_PHONE = '+966 55 141 5599';
export const QR_CID = 'traced-qr';

type Rendered = { subject: string; text: string; html: string };
type Block =
  | { kind: 'p'; text: string }
  | { kind: 'tracking'; label: string; value: string }
  | { kind: 'qr'; alt: string; caption: string }
  | { kind: 'info'; title: string; lines: string[] }
  | { kind: 'steps'; title: string; items: string[] };
type Copy = { subject: string; preheader: string; heading: string; blocks: Block[]; action?: string };

const T = {
  en: {
    help: 'Need help? Contact us at',
    rights: 'You received this email because of activity on your TRACED account.',
    hello: (name?: string) => (name ? `Dear ${name},` : 'Hello,'),
  },
  ar: {
    help: 'هل تحتاج إلى مساعدة؟ تواصل معنا على',
    rights: 'وصلتك هذه الرسالة بسبب نشاط في حسابك على TRACED.',
    hello: (name?: string) => (name ? `عزيزي/عزيزتي ${name}،` : 'مرحبًا،'),
  },
};

const INSTRUCTIONS = {
  en: [
    'Bring this QR code to the collection branch, on your phone or printed.',
    'The patient must attend in person. A child must be accompanied by the parent or guardian who registered them.',
    'Collection staff will check the QR code and complete identity verification before collecting the hair sample.',
  ],
  ar: [
    'أحضر رمز QR هذا إلى فرع جمع العينة، على هاتفك أو مطبوعًا.',
    'يجب حضور المريض شخصيًا، ويجب أن يرافق الطفلَ وليُّ أمره أو الوصي الذي سجّله.',
    'سيتحقق موظفو جمع العينات من رمز QR ويُكملون التحقق من الهوية قبل جمع عينة الشعر.',
  ],
};

/** Customer-facing collection instructions (also shown in the portal). PROVISIONAL. */
export function collectionInstructions(locale: Locale): string[] {
  return INSTRUCTIONS[locale];
}

function registrationCopy(locale: Locale, d: Record<string, string>, resend: boolean): Copy {
  const branchLines = [d.branchName, d.branchCity, d.branchAddress].filter((x): x is string => Boolean(x));
  if (locale === 'ar') {
    return {
      subject: resend ? `رمز QR الخاص بتسجيلك في TRACED – ${d.trackingId}` : `تم تأكيد تسجيلك في TRACED – ${d.trackingId}`,
      preheader: `رقم التتبع ${d.trackingId}. أحضر رمز QR إلى فرع جمع العينة.`,
      heading: resend ? 'رمز QR الخاص بك' : 'تم تأكيد تسجيلك',
      blocks: [
        { kind: 'p', text: T.ar.hello(d.name) },
        { kind: 'p', text: resend ? 'كما طلبت، هذا رمز QR الخاص بتسجيلك في TRACED.' : 'شكرًا لك. تم استلام تسجيلك في اختبار TRACED للشعر بنجاح.' },
        { kind: 'tracking', label: 'رقم التتبع', value: d.trackingId! },
        { kind: 'qr', alt: `رمز QR لرقم التتبع ${d.trackingId}`, caption: 'اعرض هذا الرمز في فرع جمع العينة. لا تشاركه مع الآخرين.' },
        { kind: 'info', title: 'فرع جمع العينة', lines: branchLines },
        { kind: 'steps', title: 'تعليمات جمع العينة', items: INSTRUCTIONS.ar },
      ],
      action: 'عرض تسجيلي',
    };
  }
  return {
    subject: resend ? `Your TRACED QR code – ${d.trackingId}` : `Your TRACED registration is confirmed – ${d.trackingId}`,
    preheader: `Tracking ID ${d.trackingId}. Bring your QR code to the collection branch.`,
    heading: resend ? 'Your QR code' : 'Registration confirmed',
    blocks: [
      { kind: 'p', text: T.en.hello(d.name) },
      { kind: 'p', text: resend ? 'As requested, here is the QR code for your TRACED registration.' : 'Thank you. Your TRACED hair test registration has been received.' },
      { kind: 'tracking', label: 'Tracking ID', value: d.trackingId! },
      { kind: 'qr', alt: `QR code for tracking ID ${d.trackingId}`, caption: 'Show this code at the collection branch. Please don’t share it.' },
      { kind: 'info', title: 'Collection branch', lines: branchLines },
      { kind: 'steps', title: 'Collection instructions', items: INSTRUCTIONS.en },
    ],
    action: 'View my registration',
  };
}

const COPY: Record<TemplateName, (locale: Locale, d: Record<string, string>) => Copy> = {
  verify_email: (l) => l === 'ar'
    ? { subject: 'تأكيد البريد الإلكتروني لحسابك في TRACED', preheader: 'أكّد بريدك الإلكتروني لإكمال إنشاء حسابك.', heading: 'تأكيد بريدك الإلكتروني', blocks: [{ kind: 'p', text: 'مرحبًا بك في TRACED.' }, { kind: 'p', text: 'يرجى تأكيد بريدك الإلكتروني لإكمال إنشاء حسابك. تنتهي صلاحية هذا الرابط خلال 24 ساعة.' }], action: 'تأكيد البريد الإلكتروني' }
    : { subject: 'Verify your TRACED account email', preheader: 'Confirm your email to finish creating your account.', heading: 'Verify your email', blocks: [{ kind: 'p', text: 'Welcome to TRACED.' }, { kind: 'p', text: 'Please confirm your email address to finish creating your account. This link expires in 24 hours.' }], action: 'Verify email' },
  account_exists: (l) => l === 'ar'
    ? { subject: 'محاولة إنشاء حساب TRACED باستخدام بريدك الإلكتروني', preheader: 'لديك حساب بالفعل.', heading: 'لديك حساب بالفعل', blocks: [{ kind: 'p', text: 'تم طلب إنشاء حساب جديد باستخدام هذا البريد الإلكتروني، ولديك حساب TRACED بالفعل.' }, { kind: 'p', text: 'إذا كنت أنت، فسجّل الدخول أو أعد تعيين كلمة المرور. وإن لم تكن أنت، يمكنك تجاهل هذه الرسالة.' }], action: 'تسجيل الدخول' }
    : { subject: 'Someone tried to create a TRACED account with your email', preheader: 'You already have an account.', heading: 'You already have an account', blocks: [{ kind: 'p', text: 'A new account was requested using this email address, but you already have a TRACED account.' }, { kind: 'p', text: 'If this was you, sign in or reset your password. If not, you can ignore this email.' }], action: 'Sign in' },
  reset_password: (l) => l === 'ar'
    ? { subject: 'إعادة تعيين كلمة مرور TRACED', preheader: 'رابط صالح لمدة 30 دقيقة.', heading: 'إعادة تعيين كلمة المرور', blocks: [{ kind: 'p', text: 'تلقّينا طلبًا لإعادة تعيين كلمة المرور. تنتهي صلاحية هذا الرابط خلال 30 دقيقة ويمكن استخدامه مرة واحدة.' }, { kind: 'p', text: 'إذا لم تطلب ذلك، يمكنك تجاهل هذه الرسالة.' }], action: 'إعادة تعيين كلمة المرور' }
    : { subject: 'Reset your TRACED password', preheader: 'This link is valid for 30 minutes.', heading: 'Reset your password', blocks: [{ kind: 'p', text: 'We received a request to reset your password. This link expires in 30 minutes and can be used once.' }, { kind: 'p', text: 'If you did not ask for this, you can ignore this email.' }], action: 'Reset password' },
  password_changed: (l) => l === 'ar'
    ? { subject: 'تم تغيير كلمة مرور TRACED', preheader: 'تم تسجيل خروجك من الأجهزة الأخرى.', heading: 'تم تغيير كلمة المرور', blocks: [{ kind: 'p', text: 'تم تغيير كلمة المرور الخاصة بك للتو وتسجيل خروجك من الأجهزة الأخرى.' }, { kind: 'p', text: `إذا لم تكن أنت، فأعد تعيين كلمة المرور فورًا وتواصل معنا على ${SUPPORT_EMAIL}.` }] }
    : { subject: 'Your TRACED password was changed', preheader: 'You were signed out of other devices.', heading: 'Password changed', blocks: [{ kind: 'p', text: 'Your password was just changed and you were signed out of other devices.' }, { kind: 'p', text: `If this wasn’t you, reset your password now and contact ${SUPPORT_EMAIL}.` }] },
  account_setup: (l) => l === 'ar'
    ? { subject: 'إعداد حساب الموظف في TRACED', preheader: 'اختر كلمة مرور لتفعيل حسابك.', heading: 'إعداد حسابك', blocks: [{ kind: 'p', text: 'أنشأ أحد المسؤولين حسابًا لك في TRACED.' }, { kind: 'p', text: 'اختر كلمة مرور لتفعيله. تنتهي صلاحية هذا الرابط خلال 72 ساعة ويمكن استخدامه مرة واحدة.' }], action: 'تعيين كلمة المرور' }
    : { subject: 'Set up your TRACED staff account', preheader: 'Choose a password to activate your account.', heading: 'Set up your account', blocks: [{ kind: 'p', text: 'An administrator created a TRACED account for you.' }, { kind: 'p', text: 'Choose a password to activate it. This link expires in 72 hours and can be used once.' }], action: 'Set password' },
  registration_confirmation: (l, d) => registrationCopy(l, d, false),
  registration_qr_resend: (l, d) => registrationCopy(l, d, true),
};

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);
}

const FONT_EN = "'Helvetica Neue',Helvetica,Arial,sans-serif";
const FONT_AR = 'Tahoma,Arial,sans-serif';

function blockHtml(b: Block, align: string, font: string): string {
  switch (b.kind) {
    case 'p':
      return `<p style="margin:0 0 16px;font:15px/1.6 ${font};color:#201f1a;text-align:${align}">${esc(b.text)}</p>`;
    case 'tracking':
      return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:8px 0 20px"><tr><td style="background:#e3e9d5;border-radius:16px;padding:16px 20px;text-align:center">
<div style="font:13px/1.4 ${font};color:#615e50;margin-bottom:4px">${esc(b.label)}</div>
<div dir="ltr" style="font:600 22px/1.3 'Courier New',Courier,monospace;letter-spacing:1px;color:#201f1a">${esc(b.value)}</div></td></tr></table>`;
    case 'qr':
      return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 20px"><tr><td align="center">
<img src="cid:${QR_CID}" width="220" height="220" alt="${esc(b.alt)}" style="display:block;width:220px;height:220px;border:1px solid #eaeaea;border-radius:12px">
<p style="margin:10px 0 0;font:13px/1.5 ${font};color:#615e50;text-align:center">${esc(b.caption)}</p></td></tr></table>`;
    case 'info':
      return b.lines.length
        ? `<p style="margin:0 0 6px;font:600 14px/1.4 ${font};color:#201f1a;text-align:${align}">${esc(b.title)}</p>
<p style="margin:0 0 20px;font:14px/1.6 ${font};color:#413f32;text-align:${align}">${b.lines.map(esc).join('<br>')}</p>`
        : '';
    case 'steps':
      return `<p style="margin:0 0 6px;font:600 14px/1.4 ${font};color:#201f1a;text-align:${align}">${esc(b.title)}</p>
<ol style="margin:0 0 20px;padding-${align === 'right' ? 'right' : 'left'}:20px;font:14px/1.6 ${font};color:#413f32;text-align:${align}">${b.items.map((i) => `<li style="margin:0 0 6px">${esc(i)}</li>`).join('')}</ol>`;
  }
}

function blockText(b: Block): string {
  switch (b.kind) {
    case 'p': return b.text;
    case 'tracking': return `${b.label}: ${b.value}`;
    case 'qr': return b.caption;
    case 'info': return b.lines.length ? `${b.title}:\n${b.lines.join('\n')}` : '';
    case 'steps': return `${b.title}:\n${b.items.map((i, n) => `${n + 1}. ${i}`).join('\n')}`;
  }
}

export function renderTemplate(name: TemplateName, locale: Locale, data: Record<string, string>): Rendered {
  const copy = COPY[name](locale, data);
  const ar = locale === 'ar';
  const align = ar ? 'right' : 'left';
  const font = ar ? FONT_AR : FONT_EN;
  const t = T[locale];
  const link = data.link;

  const text = [copy.heading, '', ...copy.blocks.map(blockText).filter(Boolean).flatMap((x) => [x, '']), ...(link ? [link, ''] : []), `${t.help} ${SUPPORT_EMAIL} · ${SUPPORT_PHONE}`].join('\n');

  const button = link && copy.action
    ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px 0 24px"${ar ? ' align="right"' : ''}><tr><td style="background:#201f1a;border-radius:999px">
<a href="${esc(link)}" style="display:inline-block;padding:14px 28px;font:600 15px/1 ${font};color:#ffffff;text-decoration:none">${esc(copy.action)}</a></td></tr></table>`
    : '';

  const html = `<!doctype html>
<html lang="${ar ? 'ar' : 'en'}" dir="${ar ? 'rtl' : 'ltr'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>${esc(copy.subject)}</title></head>
<body style="margin:0;padding:0;background:#f5f5f5">
<div style="display:none;max-height:0;overflow:hidden;opacity:0">${esc(copy.preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f5"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border-radius:24px;overflow:hidden">
<tr><td style="padding:24px 32px;border-bottom:1px solid #eaeaea;text-align:${align}"><span style="font:600 24px/1 Georgia,'Times New Roman',serif;color:#413f32;letter-spacing:.5px">Traced</span></td></tr>
<tr><td style="padding:32px 32px 8px">
<h1 style="margin:0 0 20px;font:400 28px/1.2 ${ar ? FONT_AR : "Georgia,'Times New Roman',serif"};color:#201f1a;text-align:${align}">${esc(copy.heading)}</h1>
${copy.blocks.map((b) => blockHtml(b, align, font)).join('\n')}
${button}
</td></tr>
<tr><td style="padding:20px 32px 28px;background:#fafafa;border-top:1px solid #eaeaea">
<p style="margin:0 0 6px;font:13px/1.6 ${font};color:#615e50;text-align:${align}">${esc(t.help)} <a href="mailto:${SUPPORT_EMAIL}" style="color:#201f1a">${SUPPORT_EMAIL}</a> · <span dir="ltr">${SUPPORT_PHONE}</span></p>
<p style="margin:0;font:12px/1.6 ${font};color:#7a7970;text-align:${align}">LinusBio MENA · ${esc(t.rights)}</p>
</td></tr></table></td></tr></table></body></html>`;
  return { subject: copy.subject, text, html };
}
