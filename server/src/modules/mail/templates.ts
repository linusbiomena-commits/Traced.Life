// Account emails for Phase 1, in English and Arabic. Phase 3 replaces these with the approved
// branded templates (and adds the registration/QR email). Arabic copy needs professional review.

export type Locale = 'en' | 'ar';
export type TemplateName = 'verify_email' | 'account_exists' | 'reset_password' | 'password_changed' | 'account_setup';

type Rendered = { subject: string; text: string; html: string };
type Copy = { subject: string; lines: string[]; action?: string };

const SUPPORT = 'LinusBio@karama.tech';

const COPY: Record<TemplateName, Record<Locale, (d: Record<string, string>) => Copy>> = {
  verify_email: {
    en: () => ({
      subject: 'Verify your TRACED account email',
      lines: ['Welcome to TRACED.', 'Please confirm your email address to finish creating your account. This link expires in 24 hours.'],
      action: 'Verify email',
    }),
    ar: () => ({
      subject: 'تأكيد البريد الإلكتروني لحسابك في TRACED',
      lines: ['مرحبًا بك في TRACED.', 'يرجى تأكيد بريدك الإلكتروني لإكمال إنشاء حسابك. تنتهي صلاحية هذا الرابط خلال 24 ساعة.'],
      action: 'تأكيد البريد الإلكتروني',
    }),
  },
  account_exists: {
    en: () => ({
      subject: 'Someone tried to create a TRACED account with your email',
      lines: [
        'A new account was requested using this email address, but you already have a TRACED account.',
        'If this was you, sign in instead or reset your password. If not, you can ignore this email.',
      ],
      action: 'Reset password',
    }),
    ar: () => ({
      subject: 'محاولة إنشاء حساب TRACED باستخدام بريدك الإلكتروني',
      lines: [
        'تم طلب إنشاء حساب جديد باستخدام هذا البريد الإلكتروني، ولديك حساب TRACED بالفعل.',
        'إذا كنت أنت، فسجّل الدخول أو أعد تعيين كلمة المرور. وإن لم تكن أنت، يمكنك تجاهل هذه الرسالة.',
      ],
      action: 'إعادة تعيين كلمة المرور',
    }),
  },
  reset_password: {
    en: () => ({
      subject: 'Reset your TRACED password',
      lines: ['We received a request to reset your password. This link expires in 30 minutes and can be used once.', 'If you did not ask for this, you can ignore this email.'],
      action: 'Reset password',
    }),
    ar: () => ({
      subject: 'إعادة تعيين كلمة مرور TRACED',
      lines: ['تلقّينا طلبًا لإعادة تعيين كلمة المرور. تنتهي صلاحية هذا الرابط خلال 30 دقيقة ويمكن استخدامه مرة واحدة.', 'إذا لم تطلب ذلك، يمكنك تجاهل هذه الرسالة.'],
      action: 'إعادة تعيين كلمة المرور',
    }),
  },
  password_changed: {
    en: () => ({
      subject: 'Your TRACED password was changed',
      lines: ['Your password was just changed and you were signed out of other devices.', `If this wasn't you, reset your password now and contact ${SUPPORT}.`],
    }),
    ar: () => ({
      subject: 'تم تغيير كلمة مرور TRACED',
      lines: ['تم تغيير كلمة المرور الخاصة بك للتو وتسجيل خروجك من الأجهزة الأخرى.', `إذا لم تكن أنت، فأعد تعيين كلمة المرور فورًا وتواصل معنا على ${SUPPORT}.`],
    }),
  },
  account_setup: {
    en: () => ({
      subject: 'Set up your TRACED staff account',
      lines: ['An administrator created a TRACED account for you.', 'Choose a password to activate it. This link expires in 72 hours and can be used once.'],
      action: 'Set password',
    }),
    ar: () => ({
      subject: 'إعداد حساب الموظف في TRACED',
      lines: ['أنشأ أحد المسؤولين حسابًا لك في TRACED.', 'اختر كلمة مرور لتفعيله. تنتهي صلاحية هذا الرابط خلال 72 ساعة ويمكن استخدامه مرة واحدة.'],
      action: 'تعيين كلمة المرور',
    }),
  },
};

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);
}

export function renderTemplate(name: TemplateName, locale: Locale, data: Record<string, string>): Rendered {
  const copy = COPY[name][locale](data);
  const link = data.link;
  const dir = locale === 'ar' ? 'rtl' : 'ltr';
  const footer = locale === 'ar' ? `للمساعدة: ${SUPPORT}` : `Need help? ${SUPPORT}`;

  const text = [...copy.lines, ...(link ? ['', link] : []), '', footer].join('\n');
  const html = `<!doctype html><html lang="${locale}" dir="${dir}"><body style="margin:0;background:#f5f5f5;font-family:Arial,sans-serif;color:#201f1a">
<div style="max-width:560px;margin:0 auto;padding:32px 24px;background:#fff">
<p style="font-size:20px;font-weight:bold;margin:0 0 24px">TRACED</p>
${copy.lines.map((l) => `<p style="font-size:15px;line-height:1.6;margin:0 0 16px">${escapeHtml(l)}</p>`).join('\n')}
${link && copy.action ? `<p style="margin:24px 0"><a href="${escapeHtml(link)}" style="display:inline-block;background:#c7d2ac;color:#201f1a;padding:12px 24px;border-radius:999px;text-decoration:none;font-weight:bold">${escapeHtml(copy.action)}</a></p>` : ''}
<p style="font-size:13px;color:#615e50;margin:32px 0 0">${escapeHtml(footer)}</p>
</div></body></html>`;
  return { subject: copy.subject, text, html };
}
