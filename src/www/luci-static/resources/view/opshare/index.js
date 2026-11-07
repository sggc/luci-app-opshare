'use strict';
'require view';

// Thin shell: the whole UI lives in /www/opshare/ and is framework independent,
// so the same page works on every LuCI version and also standalone.
// The iframe grows to the page's real content height via postMessage, so long
// pages scroll normally instead of being clipped by a fixed-height iframe.
return view.extend({
	render: function() {
		var frame = document.createElement('iframe');
		frame.src = '/opshare/index.html';
		frame.setAttribute('scrolling', 'auto');
		frame.style.cssText = 'border:0;width:100%;height:80vh;min-height:480px;display:block;background:transparent';

		var listener = function(ev) {
			if (ev.origin !== location.origin || !ev.data ||
				typeof ev.data.opshareHeight === 'undefined') return;
			var h = parseInt(ev.data.opshareHeight, 10);
			if (!isFinite(h) || h < 200) return;
			// Hard stop before the frame can chase its own size: an iframe that
			// grows taller than the content leaves a blank strip at the bottom,
			// and any feedback between the two would make it grow forever.
			if (h > 12000) h = 12000;
			if (Math.abs(frame.offsetHeight - h) < 3) return;
			frame.style.height = h + 'px';
		};
		if (window.__opshareHeightListener)
			window.removeEventListener('message', window.__opshareHeightListener);
		window.__opshareHeightListener = listener;
		window.addEventListener('message', listener, false);
		return frame;
	}
});
