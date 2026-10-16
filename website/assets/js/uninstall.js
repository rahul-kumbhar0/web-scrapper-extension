/* PullRows uninstall feedback — builds a mailto: link (no backend). */
(function () {
  'use strict';
  var form = document.getElementById('feedback');
  if (!form) return;
  var C = window.PULLROWS_CONFIG || {};
  var to = C.SUPPORT_EMAIL || 'support@pullrows.com';
  var status = document.getElementById('feedback-status');
  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var reason = form.querySelector('input[name="reason"]:checked');
    var details = form.querySelector('#details').value.trim();
    var body = 'Reason: ' + (reason ? reason.value : '(not given)') + '\n\n' + (details || '') + '\n';
    window.location.href = 'mailto:' + to + '?subject=' + encodeURIComponent('PullRows uninstall feedback') + '&body=' + encodeURIComponent(body);
    if (status) status.textContent = 'Thanks — your email app should open now. If it doesn’t, write to ' + to + '.';
  });
})();
