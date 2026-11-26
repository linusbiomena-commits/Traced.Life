// PROVISIONAL CONSENT TEXT FOR LOCAL DEVELOPMENT ONLY.
// Written by the development team as placeholders. NOT reviewed or approved by legal counsel,
// the DPO, or a native Arabic reviewer. Must be replaced by approved documents (status 'approved')
// before production; the API refuses provisional documents when NODE_ENV=production.

import type { ConsentType } from '../registrations/rules.ts';

export const PROVISIONAL_VERSION = '0.1-provisional';

const NOTICE_EN = '[PROVISIONAL DRAFT – NOT LEGALLY APPROVED – FOR DEVELOPMENT AND TESTING ONLY]';
const NOTICE_AR = '[مسودة مؤقتة – غير معتمدة قانونيًا – للتطوير والاختبار فقط]';

export const PROVISIONAL_CONSENTS: Record<ConsentType, Record<'en' | 'ar', { title: string; body: string }>> = {
  privacy_policy: {
    en: {
      title: 'Privacy notice',
      body: `${NOTICE_EN}\n\nWe collect the information in this form to register the patient for a TRACED hair test, arrange sample collection and send results. We keep it in secure systems, share it only with people who need it to provide the service, and keep it only as long as required. Collection staff see the patient's age and gender only. You can ask to access or correct your information by contacting support.`,
    },
    ar: {
      title: 'إشعار الخصوصية',
      body: `${NOTICE_AR}\n\nنجمع المعلومات الواردة في هذا النموذج لتسجيل المريض في اختبار TRACED للشعر وترتيب جمع العينة وإرسال النتائج. نحفظ المعلومات في أنظمة آمنة ولا نشاركها إلا مع من يحتاجها لتقديم الخدمة، ونحتفظ بها للمدة اللازمة فقط. لا يرى موظفو جمع العينات إلا عمر المريض وجنسه. يمكنك طلب الاطلاع على معلوماتك أو تصحيحها بالتواصل مع الدعم.`,
    },
  },
  sample_collection_consent: {
    en: {
      title: 'Consent to hair sample collection',
      body: `${NOTICE_EN}\n\nI consent to a small hair sample being collected from the patient at the selected branch and analysed for the TRACED environmental exposure test. I understand the test is a wellness test and not a medical diagnosis.`,
    },
    ar: {
      title: 'الموافقة على جمع عينة الشعر',
      body: `${NOTICE_AR}\n\nأوافق على جمع عينة صغيرة من شعر المريض في الفرع المختار وتحليلها ضمن اختبار TRACED للتعرّض البيئي. وأفهم أن هذا الاختبار اختبار للعافية وليس تشخيصًا طبيًا.`,
    },
  },
  accuracy_declaration: {
    en: {
      title: 'Accuracy of information',
      body: `${NOTICE_EN}\n\nI confirm that the information I have provided is accurate and complete to the best of my knowledge.`,
    },
    ar: {
      title: 'صحة المعلومات',
      body: `${NOTICE_AR}\n\nأؤكد أن المعلومات التي قدمتها صحيحة وكاملة على حد علمي.`,
    },
  },
  guardian_authorization: {
    en: {
      title: 'Parent or guardian authorisation',
      body: `${NOTICE_EN}\n\nI confirm that I am the patient's parent or legally authorised guardian or representative, and that I am entitled to register the patient and give consent on their behalf.`,
    },
    ar: {
      title: 'تفويض ولي الأمر أو الوصي',
      body: `${NOTICE_AR}\n\nأؤكد أنني والد المريض أو وليّ أمره أو ممثله المفوّض قانونيًا، وأنه يحق لي تسجيله وإعطاء الموافقة نيابةً عنه.`,
    },
  },
};
