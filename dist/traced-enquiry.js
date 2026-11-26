// Traced product page: "Send enquiry" form. The site has no server, so on submit the form checks
// every field and then opens the visitor's email app with a ready-to-send enquiry.
(function () {
  var TO = 'LinusBio@karama.tech';
  var form = document.getElementById('traced-enquiry-form');
  if (!form) return;
  var ar = document.documentElement.lang.indexOf('ar') === 0;
  var status = form.querySelector('.traced-enquiry__status');

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var phone = form.elements.phone;
    phone.value = phone.value.replace(/[^\d\s-]/g, '').trim();
    phone.setCustomValidity(/^\d[\d\s-]{5,15}$/.test(phone.value) ? '' :
      (ar ? 'أدخل رقم هاتف صحيحًا بدون رمز الدولة.' : 'Enter a valid phone number without the country code.'));
    if (!form.reportValidity()) return;

    var v = function (n) { return form.elements[n].value.trim(); };
    var subject = ar ? 'استفسار عن اختبار Traced' : 'Traced test enquiry';
    var body = [
      (ar ? 'الاسم الكامل: ' : 'Full name: ') + v('name'),
      (ar ? 'رقم الهاتف: ' : 'Phone number: ') + v('code') + ' ' + v('phone'),
      (ar ? 'البريد الإلكتروني: ' : 'Email: ') + v('email'),
      (ar ? 'العنوان: ' : 'Address: ') + v('address')
    ].join('\r\n');
    window.location.href = 'mailto:' + TO + '?subject=' + encodeURIComponent(subject) + '&body=' + encodeURIComponent(body);
    if (status) {
      status.textContent = ar
        ? 'جارٍ فتح تطبيق البريد لديك. اضغط "إرسال" لإتمام استفسارك. إذا لم يفتح، راسلنا على ' + TO
        : 'Opening your email app. Press Send to finish your enquiry. If it doesn’t open, email us at ' + TO;
    }
  });
  form.elements.phone.addEventListener('input', function () { this.setCustomValidity(''); });
})();
