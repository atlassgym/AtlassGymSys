/* ============================================================
   ATLAS GYM — GLOW UP RUNTIME  ·  v1
   Mejoras 100% aditivas: NO depende de window.app ni lo modifica.
   - Conteo animado de cifras (dashboard + métricas)
   - Fondo de partículas cyberpunk (canvas)
   - Reveal al entrar en viewport
   - Cerrar modales con ESC / click en el backdrop
   Todo defensivo: si algo falla, la app sigue funcionando igual.
   ============================================================ */
(function () {
    'use strict';

    var REDUCED = window.matchMedia &&
        window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    var IS_KIOSK = document.body && document.body.classList.contains('kiosk-body');

    /* ---------- util ---------- */
    function onReady(fn) {
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', fn);
        } else {
            fn();
        }
    }

    /* ============================================================
       1. CONTEO ANIMADO DE CIFRAS
       Observa los nodos de estadística; cuando la app cambia su
       texto a un número, lo anima desde el valor anterior.
       ============================================================ */
    var COUNT_IDS = [
        'stat-visits', 'stat-active', 'stat-expiring', 'stat-inactive',
        'metric-revenue', 'metric-new-members', 'metric-retention',
        'metric-store-revenue', 'metric-avg-revenue',
        'metric-cash-month', 'metric-card-month'
    ];

    function parseParts(raw) {
        // Devuelve { prefix, num, suffix, hadComma } o null si no hay número
        var txt = String(raw).trim();
        var hadComma = txt.indexOf(',') !== -1;
        var cleaned = txt.replace(/,/g, '');
        var m = cleaned.match(/^([^\d-]*)(-?\d+(?:\.\d+)?)(.*)$/);
        if (!m) return null;
        return { prefix: m[1] || '', num: parseFloat(m[2]), suffix: m[3] || '', hadComma: hadComma };
    }

    function fmt(n, parts) {
        var rounded = Math.round(n);
        var body = (parts.hadComma || Math.abs(rounded) >= 1000)
            ? rounded.toLocaleString('es-MX')
            : String(rounded);
        return parts.prefix + body + parts.suffix;
    }

    function animateCount(el, parts, from) {
        var to = parts.num;
        if (from === to) { el.textContent = fmt(to, parts); return; }
        var dur = 650;
        var start = performance.now();
        el.__glowBusy = true;
        function step(now) {
            var t = Math.min(1, (now - start) / dur);
            var eased = 1 - Math.pow(1 - t, 3); // easeOutCubic
            var val = from + (to - from) * eased;
            el.textContent = fmt(val, parts);
            if (t < 1) {
                requestAnimationFrame(step);
            } else {
                el.textContent = fmt(to, parts);
                el.__glowFrom = to;
                el.__glowBusy = false;
                el.classList.remove('glow-tick');
                // reflow para reiniciar la animación
                void el.offsetWidth;
                el.classList.add('glow-tick');
            }
        }
        requestAnimationFrame(step);
    }

    function setupCountUp() {
        if (REDUCED) return;
        COUNT_IDS.forEach(function (id) {
            var el = document.getElementById(id);
            if (!el) return;
            el.__glowFrom = 0;
            el.__glowBusy = false;

            var obs = new MutationObserver(function () {
                if (el.__glowBusy) return;            // ignora nuestras escrituras
                var parts = parseParts(el.textContent);
                if (!parts) return;                   // '***', texto, etc. → no animar
                if (parts.num === el.__glowFrom) return;
                animateCount(el, parts, el.__glowFrom || 0);
            });
            obs.observe(el, { childList: true, characterData: true, subtree: true });
        });
    }

    /* ============================================================
       2. FONDO DE PARTÍCULAS CYBERPUNK
       ============================================================ */
    function setupParticles() {
        if (REDUCED || IS_KIOSK) return;

        var canvas = document.createElement('canvas');
        canvas.id = 'glow-bg';
        document.body.insertBefore(canvas, document.body.firstChild);
        var ctx = canvas.getContext('2d');
        if (!ctx) return;

        var W, H, DPR, particles = [];
        var COLORS = ['rgba(255,0,60,', 'rgba(0,229,255,', 'rgba(255,43,214,'];
        var running = true, rafId = null;

        function resize() {
            DPR = Math.min(window.devicePixelRatio || 1, 2);
            W = canvas.width = Math.floor(window.innerWidth * DPR);
            H = canvas.height = Math.floor(window.innerHeight * DPR);
            canvas.style.width = window.innerWidth + 'px';
            canvas.style.height = window.innerHeight + 'px';
            var target = Math.min(70, Math.floor(window.innerWidth / 24));
            particles = [];
            for (var i = 0; i < target; i++) particles.push(makeParticle());
        }

        function makeParticle() {
            return {
                x: Math.random() * W,
                y: Math.random() * H,
                r: (Math.random() * 1.6 + 0.6) * DPR,
                vx: (Math.random() - 0.5) * 0.25 * DPR,
                vy: -(Math.random() * 0.4 + 0.1) * DPR,
                a: Math.random() * 0.5 + 0.15,
                tw: Math.random() * 0.02 + 0.005,
                color: COLORS[Math.floor(Math.random() * COLORS.length)]
            };
        }

        function frame() {
            if (!running) return;
            ctx.clearRect(0, 0, W, H);
            for (var i = 0; i < particles.length; i++) {
                var p = particles[i];
                p.x += p.vx; p.y += p.vy;
                p.a += p.tw;
                if (p.a > 0.7 || p.a < 0.12) p.tw *= -1;
                if (p.y < -10) { p.y = H + 10; p.x = Math.random() * W; }
                if (p.x < -10) p.x = W + 10;
                if (p.x > W + 10) p.x = -10;
                ctx.beginPath();
                ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
                ctx.fillStyle = p.color + p.a.toFixed(3) + ')';
                ctx.shadowBlur = 8 * DPR;
                ctx.shadowColor = p.color + '0.8)';
                ctx.fill();
            }
            ctx.shadowBlur = 0;

            // líneas de conexión (efecto red) — limitado para rendimiento
            for (var a = 0; a < particles.length; a++) {
                for (var b = a + 1; b < particles.length; b++) {
                    var dx = particles[a].x - particles[b].x;
                    var dy = particles[a].y - particles[b].y;
                    var dist = dx * dx + dy * dy;
                    var max = (120 * DPR) * (120 * DPR);
                    if (dist < max) {
                        var op = (1 - dist / max) * 0.12;
                        ctx.strokeStyle = 'rgba(255,0,60,' + op.toFixed(3) + ')';
                        ctx.lineWidth = DPR * 0.6;
                        ctx.beginPath();
                        ctx.moveTo(particles[a].x, particles[a].y);
                        ctx.lineTo(particles[b].x, particles[b].y);
                        ctx.stroke();
                    }
                }
            }
            rafId = requestAnimationFrame(frame);
        }

        window.addEventListener('resize', debounce(resize, 200));
        document.addEventListener('visibilitychange', function () {
            running = !document.hidden;
            if (running && rafId === null) { rafId = requestAnimationFrame(frame); }
            if (!running && rafId !== null) { cancelAnimationFrame(rafId); rafId = null; }
        });

        resize();
        frame();
    }

    function debounce(fn, ms) {
        var t;
        return function () {
            clearTimeout(t);
            t = setTimeout(fn, ms);
        };
    }

    /* ============================================================
       3. SCROLL REVEAL
       ============================================================ */
    function setupReveal() {
        if (REDUCED || !('IntersectionObserver' in window)) return;
        var SEL = '.stats-grid .card, #dashboard-advanced-metrics .metric-card-pro, .report-card, .dev-card';
        var nodes = Array.prototype.slice.call(document.querySelectorAll(SEL));
        if (!nodes.length) return;

        nodes.forEach(function (n, i) {
            n.classList.add('glow-reveal');
            n.style.transitionDelay = Math.min(i * 45, 360) + 'ms';
        });

        var io = new IntersectionObserver(function (entries) {
            entries.forEach(function (e) {
                if (e.isIntersecting) {
                    e.target.classList.add('is-visible');
                    io.unobserve(e.target);
                }
            });
        }, { threshold: 0.08 });

        nodes.forEach(function (n) { io.observe(n); });

        // Salvavidas: nada se queda oculto si el observer no dispara
        setTimeout(function () {
            nodes.forEach(function (n) { n.classList.add('is-visible'); });
        }, 1600);
    }

    /* ============================================================
       4. CERRAR MODALES — ESC / click en backdrop
       (excluye confirm/prompt para no romper sus promesas)
       ============================================================ */
    function setupModalUX() {
        var PROTECTED = { 'modal-confirm': 1, 'modal-prompt': 1 };

        function visibleModals() {
            return Array.prototype.slice.call(document.querySelectorAll('.modal'))
                .filter(function (m) {
                    if (PROTECTED[m.id]) return false;
                    var d = m.style.display;
                    return d === 'flex' || d === 'block';
                });
        }

        document.addEventListener('keydown', function (e) {
            if (e.key !== 'Escape') return;
            var mods = visibleModals();
            if (mods.length) mods[mods.length - 1].style.display = 'none';
        });

        document.querySelectorAll('.modal').forEach(function (m) {
            if (PROTECTED[m.id]) return;
            m.addEventListener('mousedown', function (e) {
                if (e.target === m) m.style.display = 'none';
            });
        });
    }

    /* ---------- init ---------- */
    onReady(function () {
        try { setupParticles(); } catch (e) { /* noop */ }
        try { setupCountUp(); } catch (e) { /* noop */ }
        try { setupReveal(); } catch (e) { /* noop */ }
        try { setupModalUX(); } catch (e) { /* noop */ }
    });
})();
