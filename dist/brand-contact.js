(() => {
  const prefix = '+966';
  // Fields with their own country-code picker (e.g. the Traced enquiry form) opt out.
  const selector = 'input[type="tel"]:not([data-own-country-code])';
  function initialize(input) {
    input.placeholder = '+966 5X XXX XXXX';
    input.setAttribute('inputmode', 'tel');
    input.setAttribute('autocomplete', 'tel');
    if (!input.value.trim()) input.value = prefix + ' ';
  }
  function initializeAll() { document.querySelectorAll(selector).forEach(initialize); }
  document.addEventListener('focusin', event => {
    if (event.target.matches(selector)) initialize(event.target);
  });
  document.addEventListener('input', event => {
    const input = event.target;
    if (!input.matches(selector) || input.value.startsWith(prefix)) return;
    let digits = input.value.replace(/[^0-9]/g, '');
    if (digits.startsWith('00966')) digits = digits.slice(5);
    else if (digits.startsWith('966')) digits = digits.slice(3);
    else if (digits.startsWith('0')) digits = digits.slice(1);
    input.value = prefix + ' ' + digits;
  });
  document.addEventListener('reset', () => setTimeout(initializeAll, 0));
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initializeAll);
  else initializeAll();
})();
