(function () {
  'use strict';

  // Add copy buttons to all code listing blocks and wire them up to
  // send a postMessage to the parent frame (the OpenShift console plugin)
  // so the text gets auto-pasted into the web terminal.

  document.addEventListener('DOMContentLoaded', function () {
    var blocks = document.querySelectorAll('.listingblock pre');

    blocks.forEach(function (pre) {
      var btn = document.createElement('button');
      btn.className = 'copy-to-terminal-btn';
      btn.title = 'Copy to terminal';
      btn.innerHTML = '&#x2398;'; // keyboard symbol
      btn.addEventListener('click', function () {
        var code = pre.querySelector('code');
        var text = (code || pre).textContent.trim();

        // Copy to clipboard
        navigator.clipboard.writeText(text).catch(function () {});

        // Send to parent plugin for auto-paste into terminal
        if (window.parent !== window) {
          window.parent.postMessage({ type: 'copy', text: text }, '*');
        }

        // Visual feedback
        btn.innerHTML = '&#x2714;'; // checkmark
        setTimeout(function () {
          btn.innerHTML = '&#x2398;';
        }, 1500);
      });

      // Position the button in the top-right of the code block
      var wrapper = pre.closest('.listingblock') || pre.parentElement;
      wrapper.style.position = 'relative';
      wrapper.appendChild(btn);
    });
  });
})();
