// ==UserScript==
// @name         Automatický převodník měn a kalkulačka
// @namespace    https://github.com/Martin-CHT/Skripty
// @version      2.00.0
// @description  Automaticky převádí cizí měny, obsahuje přemístitelný HUD s kalkulačkou a blacklistem, tabulku kurzů a funguje jako kalkulačka v textových polích.
// @author       Martin
// @copyright    2026, Martin
// @license      Proprietary - internal use only
// @homepageURL  https://github.com/Martin-CHT/Skripty
// @updateURL    https://raw.githubusercontent.com/Martin-CHT/Skripty/master/Skript/Prevodnik-men.user.js
// @downloadURL  https://raw.githubusercontent.com/Martin-CHT/Skripty/master/Skript/Prevodnik-men.user.js
// @supportURL   https://github.com/Martin-CHT/Skripty/issues
// @icon         https://www.google.com/s2/favicons?sz=64&domain=open.er-api.com
// @icon64       https://www.google.com/s2/favicons?sz=64&domain=open.er-api.com
// @match        *://*/*
// @noframes
// @run-at       document-idle
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// @connect      open.er-api.com
// ==/UserScript==

(function() {
    'use strict';

    const currentHost = window.location.hostname.toLowerCase();

    const defaultSettings = {
        enabled: true,
        conversionMode: 'permanent', // 'permanent', 'onclick_convert', 'onclick_orig'
        originalPosition: 'inline',   // 'inline', 'below'
        rounding: 'whole',            // 'none', 'whole', 'tens', 'hundreds'
        thousandSeparator: 'space',   // 'space', 'dot', 'none'
        minimized: true,              // Výchozí stav je minimalizováno
        targetCurrency: 'CZK',        // Cílová měna převodu
        blacklist: [],                // Seznam zakázaných domén
        hudPosition: { bottom: 20, right: 20 } // Uložená pozice tlačítka
    };

    let storedSettings = GM_getValue('currency_settings', {});
    if (storedSettings.conversionMode === 'onclick') {
        storedSettings.conversionMode = 'onclick_convert';
    }
    let settings = Object.assign({}, defaultSettings, storedSettings);
    if (!Array.isArray(settings.blacklist)) settings.blacklist = [];
    if (!settings.hudPosition || typeof settings.hudPosition.bottom !== 'number') {
        settings.hudPosition = { bottom: 20, right: 20 };
    }

    const isBlacklisted = settings.blacklist.includes(currentHost);

    let exchangeRates = {}; // Kurzy vztažené k USD
    let currencyFound = false;
    let activeCurrencies = new Set(['EUR', 'USD']); // Měny pro zobrazení v tabulce
    let lastRatesFetchTime = GM_getValue('exchange_rates_time_usd', 0);
    let isMutatingDOM = false; // Zámek proti zacyklení MutationObserveru při vlastních úpravách

    // Ignorované elementy (1C)
    const IGNORED_TAGS = new Set([
        'script', 'style', 'textarea', 'input', 'noscript', 'code', 'pre',
        'svg', 'canvas', 'template', 'math', 'rich-textarea'
    ]);

    // Slovník symbolů, zkratek a slovních tvarů
    const rawCurrencyTokens = [
        '€', '$', 'US$', '£', '¥', 'zł', 'zl', 'Kč', 'kč', 'KC', 'kc',
        'EUR', 'EURO', 'USD', 'CZK', 'GBP', 'PLN', 'HUF', 'CHF', 'JPY',
        'dolarů', 'dolarech', 'dolarům', 'dolary', 'dolaru', 'dolar',
        'korunách', 'korunám', 'korunou', 'koruny', 'koruna', 'korun',
        'eurech', 'eurům', 'eury', 'eura', 'euro', 'eur',
        'librách', 'librám', 'librou', 'libry', 'libra', 'liber',
        'zlotých', 'złotych', 'zloté', 'złote', 'zloty', 'złoty',
        'franků', 'franky', 'franku', 'frank',
        'forintů', 'forinty', 'forintu', 'forint',
        'jenů', 'jeny', 'jenu', 'jen',
        'dollars', 'dollar', 'bucks', 'buck',
        'euros', 'crowns', 'crown', 'pounds', 'pound', 'quid',
        'francs', 'franc', 'yens', 'yen'
    ];

    const sortedTokens = Array.from(new Set(rawCurrencyTokens)).sort((a, b) => b.length - a.length);
    const symRegexStr = sortedTokens.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');

    // Podpora pro násobky k, M, B, tis., mil., mld. (2A)
    const multRegexStr = `(?:[kKmMbB]|tis\\.?|mil\\.?|mld\\.?)`;
    const numRegexStr = `-?\\d{1,3}(?:[\\s\\xA0.,']\\d{3})*(?:[.,]\\d{1,2}|,-)?|-?\\d+(?:[.,]\\d{1,2}|,-)?`;

    // Regulární výraz pro cenové rozsahy (2B), např. 100 - 200 EUR, €50–€80, 5 až 10 dolarů
    const rangeRegex = new RegExp(
        `(?<![a-zA-Z0-9\u00C0-\u017F])(?:(${symRegexStr})\\s*)?(${numRegexStr})\\s*(${multRegexStr})?\\s*(?:-|–|—|\\baž\\b|\\bto\\b)\\s*(?:(${symRegexStr})\\s*)?(${numRegexStr})\\s*(${multRegexStr})?(?:\\s*(${symRegexStr}))?(?=[\\s.,;!?<)\\]]|$)`,
        'gi'
    );

    // Jednoduché ceny s násobky
    const singleRegex = new RegExp(
        `(?:(?<![a-zA-Z0-9\u00C0-\u017F])(${symRegexStr})(\\s*)(${numRegexStr})\\s*(${multRegexStr})?)|` +
        `(?:(?<![a-zA-Z0-9\u00C0-\u017F])(${numRegexStr})\\s*(${multRegexStr})?(\\s*)(${symRegexStr})(?=[\\s.,;!?<)\\]]|$))`,
        'gi'
    );

    function parseMultiplier(str) {
        if (!str) return 1;
        const s = str.toLowerCase().replace('.', '');
        if (s === 'k' || s === 'tis') return 1000;
        if (s === 'm' || s === 'mil') return 1000000;
        if (s === 'b' || s === 'mld') return 1000000000;
        return 1;
    }

    function parseNumber(numStr, multStr) {
        if (!numStr) return NaN;
        let clean = numStr.replace(/[\s\xA0'']/g, '').replace(/,-\s*$/, '');
        let dotIdx = clean.lastIndexOf('.');
        let commaIdx = clean.lastIndexOf(',');

        if (dotIdx !== -1 && commaIdx !== -1) {
            if (dotIdx > commaIdx) clean = clean.replace(/,/g, '');
            else clean = clean.replace(/\./g, '').replace(',', '.');
        } else if (commaIdx !== -1) {
            let digitsAfter = clean.length - commaIdx - 1;
            if (clean.indexOf(',') !== commaIdx || digitsAfter === 3) clean = clean.replace(/,/g, '');
            else clean = clean.replace(',', '.');
        } else if (dotIdx !== -1) {
            let digitsAfter = clean.length - dotIdx - 1;
            if (digitsAfter === 3 && (clean.match(/\./g) || []).length >= 1) clean = clean.replace(/\./g, '');
        }
        const base = parseFloat(clean);
        if (isNaN(base)) return NaN;
        return base * parseMultiplier(multStr);
    }

    function getCurrencyCode(sym) {
        if (!sym) return '';
        const s = sym.trim().toLowerCase().replace(/\\/g, '');

        if (['$', 'us$', 'usd', 'dolar', 'dolaru', 'dolary', 'dolarů', 'dolarech', 'dolarům', 'dollar', 'dollars', 'buck', 'bucks'].includes(s)) return 'USD';
        if (['€', 'eur', 'euro', 'eura', 'eurech', 'eurům', 'eury', 'euros'].includes(s)) return 'EUR';
        if (['kč', 'kc', 'czk', 'korun', 'koruny', 'koruna', 'korunách', 'korunám', 'korunou', 'crown', 'crowns'].includes(s)) return 'CZK';
        if (['£', 'gbp', 'libra', 'libry', 'liber', 'librou', 'librách', 'librám', 'pound', 'pounds', 'quid'].includes(s)) return 'GBP';
        if (['zł', 'zl', 'pln', 'zloty', 'zlotých', 'zloté', 'złoty', 'złotych', 'złote'].includes(s)) return 'PLN';
        if (['chf', 'frank', 'franku', 'franky', 'franků', 'franc', 'francs'].includes(s)) return 'CHF';
        if (['huf', 'forint', 'forintu', 'forinty', 'forintů'].includes(s)) return 'HUF';
        if (['¥', 'jpy', 'jen', 'jenu', 'jeny', 'jenů', 'yen', 'yens'].includes(s)) return 'JPY';

        return s.toUpperCase();
    }

    function convertAmount(amount, fromCode, toCode) {
        if (fromCode === toCode) return amount;
        const rateFrom = exchangeRates[fromCode];
        const rateTo = exchangeRates[toCode];
        if (!rateFrom || !rateTo) return null;
        return amount * (rateTo / rateFrom);
    }

    function formatCurrency(amount, currencyCode) {
        let rounded = amount;
        if (settings.rounding === 'whole') rounded = Math.round(amount);
        else if (settings.rounding === 'tens') rounded = Math.round(amount / 10) * 10;
        else if (settings.rounding === 'hundreds') rounded = Math.round(amount / 100) * 100;

        let str = settings.rounding === 'none' ? rounded.toFixed(2).replace(/\.00$/, '') : rounded.toString();

        if (settings.thousandSeparator !== 'none') {
            const parts = str.split('.');
            const sep = settings.thousandSeparator === 'space' ? ' ' : '.';
            parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, sep);
            str = parts.join(currencyCode === 'CZK' ? ',' : '.');
        } else if (currencyCode === 'CZK') {
            str = str.replace('.', ',');
        }

        return `${str} ${currencyCode}`;
    }

    function injectGlobalStyles() {
        if (document.getElementById('tm-currency-global-style')) return;
        const style = document.createElement('style');
        style.id = 'tm-currency-global-style';
        style.textContent = `
            .tm-currency-wrap {
                display: inline;
                transition: opacity 0.15s ease-in-out;
            }
            .tm-currency-wrap.tm-currency-below {
                display: inline-flex !important;
                flex-direction: column !important;
                vertical-align: middle !important;
                line-height: 1.15 !important;
                margin: 0 2px !important;
            }
            .tm-currency-click {
                cursor: pointer !important;
                user-select: text;
            }
            .tm-currency-click:hover {
                opacity: 0.85;
            }
            .tm-currency-orig {
                color: inherit;
                opacity: 0.8;
                font-size: 0.85em;
                font-weight: normal;
            }
            .tm-currency-below .tm-currency-orig {
                font-size: 0.75em;
            }
        `;
        document.head.appendChild(style);
    }

    function updateWrapContent(wrap) {
        const mode = wrap.getAttribute('data-mode') || settings.conversionMode;
        const state = wrap.getAttribute('data-state') || 'initial';
        const targetStr = wrap.getAttribute('data-target');
        const origStr = wrap.getAttribute('data-orig');
        const pos = settings.originalPosition;

        if (mode === 'onclick_convert') {
            if (state === 'initial') {
                wrap.className = 'tm-currency-wrap tm-currency-click';
                wrap.title = `Kliknutím zobrazíte převod: ${targetStr}`;
                wrap.style.borderBottom = '1px dashed rgba(37,99,235,0.6)';
                wrap.innerHTML = `<span>${origStr}</span>`;
            } else {
                wrap.title = `Kliknutím zobrazíte původní: ${origStr}`;
                wrap.style.borderBottom = 'none';
                if (pos === 'below') {
                    wrap.className = 'tm-currency-wrap tm-currency-below tm-currency-click';
                    wrap.innerHTML = `<span class="tm-currency-target">${targetStr}</span><span class="tm-currency-orig">(${origStr})</span>`;
                } else {
                    wrap.className = 'tm-currency-wrap tm-currency-click';
                    wrap.innerHTML = `<span class="tm-currency-target">${targetStr}</span> <span class="tm-currency-orig">(${origStr})</span>`;
                }
            }
        } else if (mode === 'onclick_orig') {
            if (state === 'initial') {
                wrap.className = 'tm-currency-wrap tm-currency-click';
                wrap.title = `Kliknutím zobrazíte původní částku: ${origStr}`;
                wrap.style.borderBottom = '1px dashed rgba(16,185,129,0.6)';
                wrap.innerHTML = `<span>${targetStr}</span>`;
            } else {
                wrap.title = `Kliknutím skryjete původní částku (${origStr})`;
                wrap.style.borderBottom = 'none';
                if (pos === 'below') {
                    wrap.className = 'tm-currency-wrap tm-currency-below tm-currency-click';
                    wrap.innerHTML = `<span class="tm-currency-target">${targetStr}</span><span class="tm-currency-orig">(${origStr})</span>`;
                } else {
                    wrap.className = 'tm-currency-wrap tm-currency-click';
                    wrap.innerHTML = `<span class="tm-currency-target">${targetStr}</span> <span class="tm-currency-orig">(${origStr})</span>`;
                }
            }
        } else {
            wrap.title = `Převedeno z: ${origStr}`;
            wrap.style.borderBottom = 'none';
            if (pos === 'below') {
                wrap.className = 'tm-currency-wrap tm-currency-below';
                wrap.innerHTML = `<span class="tm-currency-target">${targetStr}</span><span class="tm-currency-orig">(${origStr})</span>`;
            } else {
                wrap.className = 'tm-currency-wrap';
                wrap.innerHTML = `<span class="tm-currency-target">${targetStr}</span> <span class="tm-currency-orig">(${origStr})</span>`;
            }
        }
    }

    function createCurrencyElement(targetStr, origStr) {
        const span = document.createElement('span');
        span.setAttribute('data-target', targetStr);
        span.setAttribute('data-orig', origStr);
        span.setAttribute('data-mode', settings.conversionMode);
        span.setAttribute('data-state', 'initial');
        updateWrapContent(span);
        return span;
    }

    document.addEventListener('click', (e) => {
        const wrap = e.target.closest('.tm-currency-wrap');
        if (!wrap) return;

        const mode = wrap.getAttribute('data-mode') || settings.conversionMode;
        if (mode === 'onclick_convert' || mode === 'onclick_orig') {
            e.preventDefault();
            e.stopPropagation();

            const currentState = wrap.getAttribute('data-state') || 'initial';
            wrap.setAttribute('data-state', currentState === 'initial' ? 'toggled' : 'initial');
            updateWrapContent(wrap);
        }
    }, true);

    function processTextNode(node) {
        if (!node || !node.parentNode) return;
        // Striktní ochrana: nikdy neupravovat text v editovatelných polích a editorech
        if (isNodeIgnored(node)) return;

        const text = node.nodeValue;
        if (!text || text.trim() === '') return;

        const matches = [];

        // 1. Vyhledání rozsahů cen (např. 100 - 200 EUR, €50 - €80)
        rangeRegex.lastIndex = 0;
        let rMatch;
        while ((rMatch = rangeRegex.exec(text)) !== null) {
            const sym = rMatch[1] || rMatch[4] || rMatch[7];
            if (!sym) continue;
            const code = getCurrencyCode(sym);
            if (!code) continue;

            const val1 = parseNumber(rMatch[2], rMatch[3]);
            const val2 = parseNumber(rMatch[5], rMatch[6]);
            if (isNaN(val1) || isNaN(val2)) continue;

            activeCurrencies.add(code);
            currencyFound = true;

            if (settings.enabled && !isBlacklisted && code !== settings.targetCurrency) {
                const conv1 = convertAmount(val1, code, settings.targetCurrency);
                const conv2 = convertAmount(val2, code, settings.targetCurrency);
                if (conv1 !== null && conv2 !== null) {
                    const formatted1 = formatCurrency(conv1, settings.targetCurrency);
                    const formatted2 = formatCurrency(conv2, settings.targetCurrency);
                    const targetStr = `${formatted1} – ${formatted2}`;
                    const origStr = rMatch[0].trim();
                    matches.push({
                        index: rMatch.index,
                        length: rMatch[0].length,
                        targetStr,
                        origStr
                    });
                }
            }
        }

        // 2. Vyhledání jednotlivých částek
        singleRegex.lastIndex = 0;
        let sMatch;
        while ((sMatch = singleRegex.exec(text)) !== null) {
            // Přeskočit, pokud se překrývá s již nalezeným rozsahem
            const mStart = sMatch.index;
            const mEnd = sMatch.index + sMatch[0].length;
            const overlaps = matches.some(m => (mStart >= m.index && mStart < m.index + m.length) || (mEnd > m.index && mEnd <= m.index + m.length));
            if (overlaps) continue;

            const isPrefix = Boolean(sMatch[1]);
            const sym = isPrefix ? sMatch[1] : sMatch[8];
            const numStr = isPrefix ? sMatch[3] : sMatch[5];
            const multStr = isPrefix ? sMatch[4] : sMatch[6];
            const space = isPrefix ? sMatch[2] : sMatch[7];

            const val = parseNumber(numStr, multStr);
            if (isNaN(val)) continue;

            const code = getCurrencyCode(sym);
            if (!code) continue;

            activeCurrencies.add(code);
            currencyFound = true;

            if (settings.enabled && !isBlacklisted && code !== settings.targetCurrency) {
                const convertedVal = convertAmount(val, code, settings.targetCurrency);
                if (convertedVal !== null) {
                    const formattedTarget = formatCurrency(convertedVal, settings.targetCurrency);
                    const origStr = isPrefix ? `${sym}${space}${numStr}${multStr || ''}` : `${numStr}${multStr || ''}${space}${sym}`;
                    matches.push({
                        index: sMatch.index,
                        length: sMatch[0].length,
                        targetStr: formattedTarget,
                        origStr: origStr.trim()
                    });
                }
            }
        }

        if (matches.length === 0) return;

        matches.sort((a, b) => a.index - b.index);

        const fragments = [];
        let lastIdx = 0;

        matches.forEach(m => {
            if (m.index > lastIdx) {
                fragments.push(document.createTextNode(text.substring(lastIdx, m.index)));
            }
            fragments.push(createCurrencyElement(m.targetStr, m.origStr));
            lastIdx = m.index + m.length;
        });

        if (lastIdx < text.length) {
            fragments.push(document.createTextNode(text.substring(lastIdx)));
        }

        const frag = document.createDocumentFragment();
        fragments.forEach(el => frag.appendChild(el));

        // Bezpečná náhrada uzlu s aktivací zámku mutací (ochrana proti zacyklení)
        try {
            if (node.parentNode) {
                isMutatingDOM = true;
                node.parentNode.replaceChild(frag, node);
            }
        } catch (e) {
            // Ignorovat, pokud uzel v mezidobí framework přemístil
        } finally {
            queueMicrotask(() => {
                isMutatingDOM = false;
            });
        }
    }

    function isNodeIgnored(node) {
        if (!node) return true;
        const el = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
        if (!el || !el.tagName) return true;

        // Okamžitá ochrana editovatelných polí (pokrývá contenteditable="true", "plaintext-only" i dědičnost)
        if (el.isContentEditable || (node.isContentEditable !== undefined && node.isContentEditable)) {
            return true;
        }

        const tag = el.tagName.toLowerCase();
        if (IGNORED_TAGS.has(tag)) return true;

        if (el.closest) {
            if (el.closest('#currency-hud-container') ||
                el.closest('#currency-tooltip') ||
                el.closest('.tm-currency-wrap') ||
                el.closest('[contenteditable]:not([contenteditable="false"])') ||
                el.closest('[role="textbox"]') ||
                el.closest('[role="searchbox"]') ||
                el.closest('[role="combobox"]') ||
                el.closest('rich-textarea') ||
                el.closest('.ProseMirror') ||
                el.closest('.ql-editor') ||
                el.closest('.monaco-editor') ||
                el.closest('[translate="no"]')) {
                return true;
            }
        }
        return false;
    }

    function walkDOM(root) {
        if (!root || isNodeIgnored(root)) return;

        if (root.nodeType === Node.TEXT_NODE) {
            processTextNode(root);
            return;
        }

        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
            acceptNode: function(node) {
                return isNodeIgnored(node) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
            }
        });

        const nodesToProcess = [];
        let node;
        while ((node = walker.nextNode())) {
            nodesToProcess.push(node);
        }
        nodesToProcess.forEach(processTextNode);

        if (currencyFound) {
            const container = document.getElementById('currency-hud-container');
            if (container) {
                container.style.display = 'block';
                updateHUDTable();
            }
        }
    }

    // Bezpečný kalkulátor pro matematické výrazy (4A)
    function evaluateMath(expr) {
        const sanitized = expr.replace(/[\s\xA0]/g, '').replace(/,/g, '.');
        if (!/^[0-9+\-*/().]+$/.test(sanitized)) return NaN;
        try {
            const fn = new Function(`'use strict'; return (${sanitized});`);
            const res = fn();
            return (typeof res === 'number' && isFinite(res)) ? res : NaN;
        } catch (e) {
            return NaN;
        }
    }

    let tooltipEl = null;
    let activeTooltipInput = null;
    let activeTooltipPrimaryReplacement = null;

    function initTooltip() {
        if (tooltipEl) return;
        tooltipEl = document.createElement('div');
        tooltipEl.id = 'currency-tooltip';
        tooltipEl.style.cssText = `
            position: fixed; z-index: 2147483647; background: #1e293b; color: #f8fafc;
            padding: 8px 12px; border-radius: 6px; font-size: 13px; font-family: sans-serif;
            box-shadow: 0 4px 10px rgba(0,0,0,0.3); pointer-events: none; opacity: 0;
            transition: opacity 0.2s; white-space: nowrap; font-weight: 500; line-height: 1.4;
        `;
        document.body.appendChild(tooltipEl);
    }

    function showTooltip(input, htmlContent) {
        if (!tooltipEl) initTooltip();
        tooltipEl.innerHTML = htmlContent;

        const rect = input.getBoundingClientRect();
        tooltipEl.style.top = `${Math.max(0, rect.top - tooltipEl.offsetHeight - 8)}px`;
        tooltipEl.style.left = `${rect.left}px`;
        tooltipEl.style.opacity = '1';
    }

    function hideTooltip() {
        if (tooltipEl) tooltipEl.style.opacity = '0';
        activeTooltipInput = null;
        activeTooltipPrimaryReplacement = null;
    }

    function handleInputEvent(e) {
        const target = e.target;
        if (!target || (!['INPUT', 'TEXTAREA'].includes(target.tagName) && !target.isContentEditable)) return;

        let text = target.value || target.innerText || "";
        if (!text.trim()) return hideTooltip();

        // Podpora matematiky před převodem (např. 15 + 25 EUR nebo 3 * 12 USD) (4A)
        const mathMatch = text.match(/((?:[0-9]+[.,]?[0-9]*\s*[\+\-\*\/]\s*)+[0-9]+[.,]?[0-9]*)\s*([a-zA-Z$€£¥złKč]+)/);
        let matches = [];

        if (mathMatch) {
            const calculatedVal = evaluateMath(mathMatch[1]);
            if (!isNaN(calculatedVal)) {
                matches.push({ full: mathMatch[0], sym: mathMatch[2], customVal: calculatedVal, mathExpr: mathMatch[1].trim() });
            }
        }

        if (matches.length === 0) {
            singleRegex.lastIndex = 0;
            let match;
            while ((match = singleRegex.exec(text)) !== null) {
                const isPrefix = Boolean(match[1]);
                const sym = isPrefix ? match[1] : match[8];
                const num = isPrefix ? match[3] : match[5];
                const mult = isPrefix ? match[4] : match[6];
                matches.push({ full: match[0], sym, num, mult });
            }
        }

        if (matches.length === 0) return hideTooltip();

        activeTooltipInput = target;
        let html = '';

        matches.forEach(m => {
            const val = m.customVal !== undefined ? m.customVal : parseNumber(m.num, m.mult);
            if (isNaN(val)) return;
            const code = getCurrencyCode(m.sym);
            if (!code) return;

            let targets = [];
            const hudTarget = settings.targetCurrency || 'CZK';

            if (code === hudTarget) {
                if (hudTarget === 'CZK') targets.push('EUR', 'USD');
                else if (hudTarget === 'EUR') targets.push('CZK', 'USD');
                else if (hudTarget === 'USD') targets.push('CZK', 'EUR');
                else ['EUR', 'USD', 'CZK'].forEach(t => { if (t !== hudTarget && !targets.includes(t)) targets.push(t); });
            } else {
                targets.push(hudTarget);
                if (code === 'EUR') {
                    if (!targets.includes('USD')) targets.push('USD');
                    if (!targets.includes('CZK')) targets.push('CZK');
                } else if (code === 'USD') {
                    if (!targets.includes('EUR')) targets.push('EUR');
                    if (!targets.includes('CZK')) targets.push('CZK');
                } else if (code === 'CZK') {
                    if (!targets.includes('EUR')) targets.push('EUR');
                    if (!targets.includes('USD')) targets.push('USD');
                } else {
                    if (!targets.includes('CZK') && hudTarget !== 'CZK') targets.push('CZK');
                    if (!targets.includes('EUR') && hudTarget !== 'EUR') targets.push('EUR');
                    if (!targets.includes('USD') && hudTarget !== 'USD') targets.push('USD');
                }
            }

            targets = targets.filter((t, idx, self) => t !== code && self.indexOf(t) === idx);

            if (m.mathExpr) {
                html += `<div style="color:#cbd5e1; font-size:11px; margin-bottom:2px;">Výpočet: ${m.mathExpr} = ${val} ${code}</div>`;
            }

            targets.forEach((tgt, idx) => {
                const converted = convertAmount(val, code, tgt);
                if (converted !== null) {
                    const resultStr = converted.toFixed(2).replace(/\.00$/, '');
                    if (idx === 0) activeTooltipPrimaryReplacement = `${resultStr} ${tgt}`;
                    html += `<div><span style="color:#94a3b8">${m.full.trim()} =</span> <span style="color:#34d399; font-weight:bold;">${resultStr} ${tgt}</span></div>`;
                }
            });
        });

        if (html) {
            html += `<div style="font-size:10px; color:#64748b; margin-top:4px; border-top:1px solid #334155; padding-top:2px;">Stiskem <b>Alt + Enter</b> vložíte převod</div>`;
            showTooltip(target, html);
        } else {
            hideTooltip();
        }
    }

    // Klávesa Alt + Enter pro okamžité nahrazení v textovém poli (4B)
    document.addEventListener('keydown', (e) => {
        if (e.altKey && e.key === 'Enter' && activeTooltipInput && activeTooltipPrimaryReplacement) {
            e.preventDefault();
            const input = activeTooltipInput;
            if (['INPUT', 'TEXTAREA'].includes(input.tagName)) {
                input.value = activeTooltipPrimaryReplacement;
                input.dispatchEvent(new Event('input', { bubbles: true }));
            } else if (input.isContentEditable) {
                input.innerText = activeTooltipPrimaryReplacement;
            }
            hideTooltip();
        }
    });

    document.addEventListener('input', handleInputEvent, true);
    document.addEventListener('focusout', hideTooltip, true);

    function fetchRates(forceRefresh = false) {
        return new Promise((resolve) => {
            const cached = GM_getValue('exchange_rates_cache_usd', null);
            const lastFetch = GM_getValue('exchange_rates_time_usd', 0);
            const now = Date.now();

            if (!forceRefresh && cached && (now - lastFetch < 12 * 60 * 60 * 1000)) {
                try {
                    lastRatesFetchTime = lastFetch;
                    resolve(JSON.parse(cached));
                    return;
                } catch (e) { }
            }

            GM_xmlhttpRequest({
                method: 'GET',
                url: 'https://open.er-api.com/v6/latest/USD',
                onload: function(response) {
                    try {
                        const data = JSON.parse(response.responseText);
                        if (data && data.rates) {
                            GM_setValue('exchange_rates_cache_usd', JSON.stringify(data.rates));
                            GM_setValue('exchange_rates_time_usd', now);
                            lastRatesFetchTime = now;
                            resolve(data.rates);
                        } else {
                            resolve(cached ? JSON.parse(cached) : {});
                        }
                    } catch (e) {
                        resolve(cached ? JSON.parse(cached) : {});
                    }
                },
                onerror: () => resolve(cached ? JSON.parse(cached) : {})
            });
        });
    }

    let shadowRoot = null;

    function formatTimeAgo(timestamp) {
        if (!timestamp) return 'neznámo';
        const diffMinutes = Math.floor((Date.now() - timestamp) / 60000);
        if (diffMinutes < 1) return 'před okamžikem';
        if (diffMinutes < 60) return `před ${diffMinutes} min`;
        const diffHours = Math.floor(diffMinutes / 60);
        if (diffHours < 24) return `před ${diffHours} hod`;
        const d = new Date(timestamp);
        return `${d.getDate()}.${d.getMonth() + 1}. ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
    }

    function updateHUDTable() {
        if (!shadowRoot || !exchangeRates || Object.keys(exchangeRates).length === 0) return;
        const tbody = shadowRoot.querySelector('#rates-tbody');
        const timeLabel = shadowRoot.querySelector('#rates-time-label');
        if (timeLabel) timeLabel.textContent = formatTimeAgo(lastRatesFetchTime);
        if (!tbody) return;

        tbody.innerHTML = '';
        const targetRate = exchangeRates[settings.targetCurrency];

        activeCurrencies.forEach(code => {
            if (code === settings.targetCurrency) return;
            const sourceRate = exchangeRates[code];
            if (!sourceRate || !targetRate) return;

            const valueInTarget = 1 * (targetRate / sourceRate);

            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td>1 ${code}</td>
                <td>=</td>
                <td style="font-weight: bold; text-align:right;">${valueInTarget.toFixed(2)} ${settings.targetCurrency}</td>
            `;
            tbody.appendChild(tr);
        });
    }

    function createHUD() {
        const container = document.createElement('div');
        container.id = 'currency-hud-container';
        container.style.cssText = `
            position: fixed;
            bottom: ${settings.hudPosition.bottom}px;
            right: ${settings.hudPosition.right}px;
            z-index: 2147483646;
            display: ${currencyFound ? 'block' : 'none'};
            user-select: none;
        `;
        document.body.appendChild(container);

        shadowRoot = container.attachShadow({ mode: 'closed' });

        const style = document.createElement('style');
        style.textContent = `
            * { box-sizing: border-box; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; }
            .app-root.mode-minimized .main-ui { display: none; }
            .app-root.mode-normal .minimized-tab { display: none; }
            .main-ui { position: relative; }

            .btn-toggle {
                background: ${isBlacklisted ? '#64748b' : '#2563eb'};
                color: white; height: 50px; border-radius: 25px; padding: 0 15px;
                display: flex; justify-content: center; align-items: center; cursor: grab; gap: 8px;
                box-shadow: 0 4px 6px -1px rgba(0,0,0,0.15); font-weight: bold; font-size: 16px;
                border: none; transition: background 0.2s;
            }
            .btn-toggle:active { cursor: grabbing; }
            .btn-toggle:hover { background: ${isBlacklisted ? '#475569' : '#1d4ed8'}; }

            .btn-minimize {
                position: absolute; top: -5px; right: -5px; width: 22px; height: 22px; background: #ef4444;
                color: white; border: none; border-radius: 50%; font-weight: bold; cursor: pointer;
                display: flex; align-items: center; justify-content: center; box-shadow: 0 2px 4px rgba(0,0,0,0.2);
                transition: transform 0.2s; font-size: 14px; line-height: 1; z-index: 2; padding-bottom: 2px;
            }
            .btn-minimize:hover { background: #dc2626; transform: scale(1.1); }

            .minimized-tab {
                position: fixed; right: 0; bottom: 30px; width: 8px; height: 40px; background: #2563eb;
                border-radius: 4px 0 0 4px; cursor: pointer; box-shadow: -2px 0 5px rgba(0,0,0,0.2);
                transition: width 0.2s; display: flex; align-items: center; justify-content: center; color: transparent;
            }
            .minimized-tab:hover { width: 24px; color: white; background: #1d4ed8; }

            .panel {
                position: absolute; bottom: 60px; right: 0; width: 330px; background: #ffffff;
                border-radius: 12px; box-shadow: 0 10px 25px -3px rgba(0,0,0,0.2); padding: 18px;
                display: none; flex-direction: column; gap: 12px; border: 1px solid #e5e7eb; max-height: 85vh; overflow-y: auto;
            }
            .panel.open { display: flex; }

            h2 { margin: 0; font-size: 15px; color: #1f2937; border-bottom: 1px solid #e5e7eb; padding-bottom: 6px; }
            .section-title { font-size: 11px; text-transform: uppercase; color: #6b7280; font-weight: bold; margin-top: 4px; display: flex; justify-content: space-between; align-items: center; }

            .form-group { display: flex; flex-direction: column; gap: 3px; }
            label { font-size: 12px; color: #4b5563; font-weight: 500; }
            select, input[type="text"] { padding: 7px; border-radius: 6px; border: 1px solid #d1d5db; font-size: 13px; background: #fff; }

            .checkbox-group { display: flex; align-items: center; gap: 10px; flex-direction: row; }
            .checkbox-group input { width: 16px; height: 16px; cursor: pointer; }

            table { width: 100%; border-collapse: collapse; font-size: 12px; margin-top: 3px; }
            td { padding: 3px 0; border-bottom: 1px dashed #e5e7eb; color: #374151; }
            tr:last-child td { border-bottom: none; }

            .btn-save {
                background: #10b981; color: white; border: none; padding: 9px; border-radius: 6px;
                font-weight: bold; cursor: pointer; margin-top: 4px; transition: background 0.2s;
            }
            .btn-save:hover { background: #059669; }

            .btn-action {
                background: #f1f5f9; color: #334155; border: 1px solid #cbd5e1; padding: 6px 10px;
                border-radius: 6px; font-size: 12px; cursor: pointer; display: flex; align-items: center; justify-content: center; gap: 4px;
            }
            .btn-action:hover { background: #e2e8f0; }

            .quick-calc-box {
                background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 10px; display: flex; flex-direction: column; gap: 6px;
            }
            .quick-calc-res { font-size: 12px; font-weight: bold; color: #059669; min-height: 16px; }
        `;

        const wrapper = document.createElement('div');
        wrapper.className = `app-root ${settings.minimized ? 'mode-minimized' : 'mode-normal'}`;

        const currencyOptions = Object.keys(exchangeRates).length > 0
            ? Object.keys(exchangeRates)
            : ['CZK', 'EUR', 'USD', 'GBP', 'PLN'];

        const optionsHtml = currencyOptions.map(c =>
            `<option value="${c}" ${settings.targetCurrency === c ? 'selected' : ''}>${c}</option>`
        ).join('');

        wrapper.innerHTML = `
            <div class="minimized-tab" title="Rozbalit převodník">◀</div>
            <div class="main-ui">
                <button class="btn-minimize" title="Minimalizovat">−</button>
                <button class="btn-toggle" title="Nastavení a kurzy (lze přetáhnout)">
                    <span id="btn-currency-label">${settings.targetCurrency}</span>
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"></path>
                        <path d="M3 3v5h5"></path>
                        <path d="M21 12a9 9 0 1 0-9 9 9.75 9.75 0 0 0 6.74-2.74L21 16"></path>
                        <path d="M16 21v-5h5"></path>
                    </svg>
                </button>
                <div class="panel">
                    <h2>Převodník a kalkulačka</h2>

                    <div class="form-group checkbox-group">
                        <input type="checkbox" id="sett-enabled" ${settings.enabled ? 'checked' : ''}>
                        <label for="sett-enabled">Aktivní převod na stránce</label>
                    </div>

                    <!-- Blacklist sekce (3A) -->
                    <button class="btn-action" id="btn-toggle-blacklist">
                        ${isBlacklisted ? '✅ Povolit převod na tomto webu' : '🚫 Vypnout pro tento web (' + currentHost + ')'}
                    </button>

                    <!-- Rychlá kalkulačka v HUD (4C) -->
                    <div class="quick-calc-box">
                        <label style="font-weight:bold; font-size:11px; text-transform:uppercase; color:#475569;">Rychlý převod v okně</label>
                        <input type="text" id="hud-quick-input" placeholder="Např. 50 EUR nebo 15 * 3 USD">
                        <div class="quick-calc-res" id="hud-quick-result">Zadejte částku a měnu...</div>
                    </div>

                    <div class="section-title">Režim zobrazení</div>

                    <div class="form-group">
                        <label>Aktivace převodu</label>
                        <select id="sett-conv-mode">
                            <option value="permanent" ${settings.conversionMode === 'permanent' ? 'selected' : ''}>Trvale převedeno (výchozí)</option>
                            <option value="onclick_convert" ${settings.conversionMode === 'onclick_convert' ? 'selected' : ''}>Původní částka (převod po kliknutí)</option>
                            <option value="onclick_orig" ${settings.conversionMode === 'onclick_orig' ? 'selected' : ''}>Převedená částka (původní po kliknutí)</option>
                        </select>
                    </div>

                    <div class="form-group">
                        <label>Pozice původní částky</label>
                        <select id="sett-orig-pos">
                            <option value="inline" ${settings.originalPosition === 'inline' ? 'selected' : ''}>Vedle převodu (v závorce)</option>
                            <option value="below" ${settings.originalPosition === 'below' ? 'selected' : ''}>Pod převodem na nový řádek</option>
                        </select>
                    </div>

                    <div class="section-title">Nastavení měny a zaokrouhlení</div>

                    <div class="form-group">
                        <label>Cílová měna</label>
                        <select id="sett-target">${optionsHtml}</select>
                    </div>

                    <div class="form-group">
                        <label>Zaokrouhlování na stránce</label>
                        <select id="sett-rounding">
                            <option value="none" ${settings.rounding === 'none' ? 'selected' : ''}>Nezaokrouhlovat (na haléře)</option>
                            <option value="whole" ${settings.rounding === 'whole' ? 'selected' : ''}>Na celé jednotky</option>
                            <option value="tens" ${settings.rounding === 'tens' ? 'selected' : ''}>Na desítky</option>
                            <option value="hundreds" ${settings.rounding === 'hundreds' ? 'selected' : ''}>Na stovky</option>
                        </select>
                    </div>

                    <!-- Stáří kurzů a manuální aktualizace (3C) -->
                    <div class="section-title">
                        <span>Aktuální kurzy (<span id="rates-time-label">${formatTimeAgo(lastRatesFetchTime)}</span>)</span>
                        <button class="btn-action" id="btn-refresh-rates" style="padding: 2px 6px; font-size: 10px;" title="Aktualizovat kurzy nyní">🔄 Obnovit</button>
                    </div>
                    <table><tbody id="rates-tbody"></tbody></table>

                    <button class="btn-save" id="btn-save">Uložit nastavení</button>
                </div>
            </div>
        `;

        shadowRoot.appendChild(style);
        shadowRoot.appendChild(wrapper);

        const appRoot = shadowRoot.querySelector('.app-root');
        const toggleBtn = shadowRoot.querySelector('.btn-toggle');
        const panel = shadowRoot.querySelector('.panel');

        // Podpora přetahování tlačítka (Drag & Drop) (3B)
        let isDragging = false;
        let hasDragged = false;
        let startX, startY, initRight, initBottom;

        toggleBtn.addEventListener('mousedown', (e) => {
            if (e.target.closest('.btn-minimize')) return;
            isDragging = true;
            hasDragged = false;
            startX = e.clientX;
            startY = e.clientY;
            initRight = parseInt(container.style.right, 10) || 20;
            initBottom = parseInt(container.style.bottom, 10) || 20;
        });

        window.addEventListener('mousemove', (e) => {
            if (!isDragging) return;
            const deltaX = startX - e.clientX;
            const deltaY = startY - e.clientY;
            if (Math.abs(deltaX) > 4 || Math.abs(deltaY) > 4) {
                hasDragged = true;
            }
            const newRight = Math.max(10, Math.min(window.innerWidth - 70, initRight + deltaX));
            const newBottom = Math.max(10, Math.min(window.innerHeight - 70, initBottom + deltaY));
            container.style.right = `${newRight}px`;
            container.style.bottom = `${newBottom}px`;
        });

        window.addEventListener('mouseup', () => {
            if (isDragging && hasDragged) {
                settings.hudPosition = {
                    bottom: parseInt(container.style.bottom, 10),
                    right: parseInt(container.style.right, 10)
                };
                GM_setValue('currency_settings', settings);
            }
            isDragging = false;
        });

        toggleBtn.addEventListener('click', (e) => {
            if (hasDragged) return; // Pokud uživatel tlačítko táhl, neotvírat panel
            panel.classList.toggle('open');
        });

        shadowRoot.querySelector('.btn-minimize').addEventListener('click', () => {
            appRoot.classList.replace('mode-normal', 'mode-minimized');
            panel.classList.remove('open');
            settings.minimized = true;
            GM_setValue('currency_settings', settings);
        });

        shadowRoot.querySelector('.minimized-tab').addEventListener('click', () => {
            appRoot.classList.replace('mode-minimized', 'mode-normal');
            settings.minimized = false;
            GM_setValue('currency_settings', settings);
        });

        // Rychlý převodník v HUD (4C)
        const quickInput = shadowRoot.querySelector('#hud-quick-input');
        const quickResult = shadowRoot.querySelector('#hud-quick-result');

        quickInput.addEventListener('input', () => {
            const valStr = quickInput.value.trim();
            if (!valStr) {
                quickResult.textContent = 'Zadejte částku a měnu...';
                return;
            }

            const mathMatch = valStr.match(/((?:[0-9]+[.,]?[0-9]*\s*[\+\-\*\/]\s*)+[0-9]+[.,]?[0-9]*)\s*([a-zA-Z$€£¥złKč]+)/);
            let val = NaN;
            let sym = '';

            if (mathMatch) {
                val = evaluateMath(mathMatch[1]);
                sym = mathMatch[2];
            } else {
                singleRegex.lastIndex = 0;
                const m = singleRegex.exec(valStr);
                if (m) {
                    const isPrefix = Boolean(m[1]);
                    sym = isPrefix ? m[1] : m[8];
                    val = parseNumber(isPrefix ? m[3] : m[5], isPrefix ? m[4] : m[6]);
                }
            }

            if (isNaN(val) || !sym) {
                quickResult.textContent = 'Rozpoznávám částku...';
                return;
            }

            const code = getCurrencyCode(sym);
            if (!code) {
                quickResult.textContent = 'Neznámá měna';
                return;
            }

            const targetCode = settings.targetCurrency;
            const converted = convertAmount(val, code, targetCode);
            if (converted !== null) {
                quickResult.innerHTML = `${val} ${code} = <span style="color:#2563eb;">${formatCurrency(converted, targetCode)}</span>`;
            }
        });

        // Tlačítko Blacklistu (3A)
        shadowRoot.querySelector('#btn-toggle-blacklist').addEventListener('click', () => {
            if (isBlacklisted) {
                settings.blacklist = settings.blacklist.filter(h => h !== currentHost);
            } else {
                settings.blacklist.push(currentHost);
            }
            GM_setValue('currency_settings', settings);
            location.reload();
        });

        // Tlačítko pro okamžitou aktualizaci kurzů (3C)
        shadowRoot.querySelector('#btn-refresh-rates').addEventListener('click', async () => {
            const btn = shadowRoot.querySelector('#btn-refresh-rates');
            btn.textContent = '⏳ ...';
            exchangeRates = await fetchRates(true);
            updateHUDTable();
            btn.textContent = '✅ Hotovo';
            setTimeout(() => { btn.textContent = '🔄 Obnovit'; }, 1500);
        });

        shadowRoot.querySelector('#btn-save').addEventListener('click', () => {
            settings.enabled = shadowRoot.querySelector('#sett-enabled').checked;
            settings.rounding = shadowRoot.querySelector('#sett-rounding').value;
            settings.targetCurrency = shadowRoot.querySelector('#sett-target').value;
            settings.conversionMode = shadowRoot.querySelector('#sett-conv-mode').value;
            settings.originalPosition = shadowRoot.querySelector('#sett-orig-pos').value;
            GM_setValue('currency_settings', settings);
            location.reload();
        });

        updateHUDTable();

        return {
            forceOpen: () => {
                container.style.display = 'block';
                appRoot.classList.replace('mode-minimized', 'mode-normal');
                panel.classList.add('open');
                settings.minimized = false;
                GM_setValue('currency_settings', settings);
            }
        };
    }

    async function init() {
        injectGlobalStyles();

        exchangeRates = await fetchRates();
        if (!exchangeRates || Object.keys(exchangeRates).length === 0) {
            console.warn("Currency Converter: Nelze načíst směnné kurzy.");
            return;
        }

        const hudAPI = createHUD();

        if (typeof GM_registerMenuCommand !== "undefined") {
            GM_registerMenuCommand("⚙️ Nastavení / Zobrazit převodník", () => {
                if (hudAPI) hudAPI.forceOpen();
            });
        }

        document.addEventListener('keydown', (e) => {
            if (e.ctrlKey && e.key === '\\') {
                e.preventDefault();
                settings.enabled = true;
                GM_setValue('currency_settings', settings);

                if (hudAPI) hudAPI.forceOpen();

                if (shadowRoot) {
                    const enabledCheckbox = shadowRoot.querySelector('#sett-enabled');
                    if (enabledCheckbox) enabledCheckbox.checked = true;
                }

                if (!isBlacklisted) walkDOM(document.body);
            }
        });

        // Pokud je doména na blacklistu, skenování stránky neprovádíme (3A)
        if (!isBlacklisted) {
            walkDOM(document.body);

            // Optimalizovaný MutationObserver s ochranou proti zacyklení a ignorováním vstupních polí
            const observer = new MutationObserver((mutations) => {
                if (isMutatingDOM) return;

                for (let i = 0; i < mutations.length; i++) {
                    const m = mutations[i];
                    if (m.type === 'childList') {
                        for (let j = 0; j < m.addedNodes.length; j++) {
                            const node = m.addedNodes[j];
                            if (node.nodeType === Node.ELEMENT_NODE) {
                                if (!isNodeIgnored(node)) {
                                    walkDOM(node);
                                }
                            } else if (node.nodeType === Node.TEXT_NODE) {
                                if (!isNodeIgnored(node)) {
                                    processTextNode(node);
                                }
                            }
                        }
                    } else if (m.type === 'characterData') {
                        // Změna textu uvnitř existujícího elementu (live burzy, tickery)
                        if (!isNodeIgnored(m.target)) {
                            processTextNode(m.target);
                        }
                    }
                }
            });

            observer.observe(document.body, {
                childList: true,
                subtree: true,
                characterData: true
            });
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
