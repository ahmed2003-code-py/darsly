/**
 * The page's own script, assembled from a core plus the behaviours the design
 * actually asked for.
 *
 * Two rules hold everything here together:
 *
 *  1. Nothing decorative may take down anything functional. The language toggle
 *     and the course listings are the page's job; a parallax that throws must
 *     not stop them, so every effect is wrapped on its own.
 *  2. No regex literals. This source is assembled inside a server-side template
 *     literal, where `/\\/a\\/…/` collapses to `//a/…/` — a syntax error that
 *     once took the entire script down and left every published page with no
 *     language toggle and its course list stuck on skeletons. Regexes are built
 *     from strings, and the emitted script is parsed by a test.
 */

/** Always emitted: language, hydration, reveal, and keeping the CTA current. */
export function coreJs(slug: string, defaultLang: 'ar' | 'en'): string {
  return `
var SLUG=(function(){
  var m=location.pathname.match(new RegExp('/a/([^/?#]+)'));
  return m?decodeURIComponent(m[1]):${JSON.stringify(slug)};
})();
/* Scroll entrance.

   The hidden state is added by script and removed by script, which means every
   section on the page is invisible until something says otherwise. That is one
   dependency too many for the content of a marketing page: an observer that
   does not fire — for any reason, in any browser, in any embedding — leaves the
   visitor a header, a footer and nothing in between.

   So the observer is the *nicety* and geometry is the guarantee. Anything on
   screen is revealed immediately and synchronously, a throttled scroll handler
   keeps revealing as you go whether or not the observer works, and a timer
   gives up on the whole effect if it has plainly failed. The animation is
   allowed to break; the page is not. */
var PENDING=[];
try{
  document.body.classList.add('reveal-on');
  document.querySelectorAll('a[data-cta]').forEach(function(a){a.setAttribute('href','/t/'+SLUG);});
  PENDING=[].slice.call(document.querySelectorAll('.block'));

  function reveal(el){
    el.classList.add('in');
    var i=PENDING.indexOf(el);
    if(i>-1)PENDING.splice(i,1);
  }
  function revealOnScreen(){
    for(var i=PENDING.length-1;i>=0;i--){
      var r=PENDING[i].getBoundingClientRect();
      if(r.top<innerHeight*0.94&&r.bottom>0)reveal(PENDING[i]);
    }
  }

  try{
    var io=new IntersectionObserver(function(es){
      es.forEach(function(e){if(e.isIntersecting)reveal(e.target);});
    },{threshold:0,rootMargin:'0px 0px -6% 0px'});
    PENDING.forEach(function(b){io.observe(b);});
  }catch(err){}

  revealOnScreen();
  var pend=false;
  addEventListener('scroll',function(){
    if(pend||!PENDING.length)return;
    pend=true;
    requestAnimationFrame(function(){pend=false;revealOnScreen();});
  },{passive:true});
  addEventListener('resize',revealOnScreen,{passive:true});
  addEventListener('load',revealOnScreen);

  // If the first screen is still hidden a moment after load, the effect is not
  // working. Drop it entirely rather than serve a blank page.
  setTimeout(function(){
    if(document.querySelector('.block:not(.hero):not(.in)')&&!document.querySelector('.block.in')){
      document.body.classList.remove('reveal-on');
    }
  },1800);
}catch(e){document.body.classList.remove('reveal-on');}

var L=localStorage.getItem('darsly_lang')||${JSON.stringify(defaultLang)};
function applyLang(l){
  document.documentElement.lang=l;
  document.documentElement.dir=(l==='ar'?'rtl':'ltr');
  document.querySelectorAll('.i18n').forEach(function(e){
    var v=e.dataset[l];
    /* Fall back rather than blank. A field the writer only filled in one
       language used to erase itself the moment the visitor was on the other
       one — which is how a credentials list rendered as seven numbered rules
       with nothing beside them. Showing the language we have beats showing
       nothing. */
    if(!v||!v.trim())v=e.dataset[l==='ar'?'en':'ar'];
    if(v!=null)e.textContent=v;
  });
  var b=document.getElementById('langToggle');if(b)b.textContent=(l==='ar'?'English':'العربية');
  try{localStorage.setItem('darsly_lang',l);}catch(err){}
}
applyLang(L);
var lt=document.getElementById('langToggle');
if(lt)lt.addEventListener('click',function(){applyLang(document.documentElement.lang==='ar'?'en':'ar');});

function esc(t){var d=document.createElement('div');d.textContent=(t==null?'':t);return d.innerHTML;}
function money(c){return (typeof c==='number')?(c/100).toLocaleString()+' EGP':'';}
function stars(n){return '★'.repeat(Math.max(0,Math.min(5,n|0)));}
function hydrate(sec){
  var kind=sec.getAttribute('data-hydrate');
  var limit=sec.getAttribute('data-limit')||6;
  var slot=sec.querySelector('[data-slot]');
  if(!slot)return;
  fetch('/api/v1/a/'+encodeURIComponent(SLUG)+'/'+kind+'?limit='+limit)
    .then(function(r){return r.ok?r.json():[];})
    .then(function(items){
      if(!Array.isArray(items)||!items.length){sec.style.display='none';return;}
      slot.innerHTML=items.map(function(it,i){
        if(kind==='courses'){
          var img=it.thumbnailUrl?'<img class="img" data-ratio="16:9" src="'+esc(it.thumbnailUrl)+'" alt="">':'';
          return '<a class="card lift glow course-card" target="_top" href="'+esc(it.url||'#')+'">'+img+
            '<div class="course-body"><h3>'+esc(it.title)+'</h3><span class="price">'+money(it.priceCents)+'</span></div></a>';
        }
        return '<figure class="card review-card"><div class="rating" aria-hidden="true">'+stars(it.rating)+'</div>'+
          '<blockquote>'+esc(it.comment||'')+'</blockquote>'+
          '<figcaption>'+esc(it.studentName||'')+'</figcaption></figure>';
      }).join('');
      sec.dispatchEvent(new CustomEvent('hydrated',{bubbles:true}));
    }).catch(function(){sec.style.display='none';});
}
document.querySelectorAll('[data-hydrate]').forEach(hydrate);
`.trim();
}

/**
 * Opt-in behaviours. Each is emitted only when the design uses it, and each is
 * wrapped so a failure stays local.
 */
export const EFFECT_JS: Record<string, string> = {
  'progress-bar': `
var bar=document.querySelector('.scroll-bar i');
if(bar){
  var t=false;
  function upd(){var h=document.documentElement.scrollHeight-innerHeight;bar.style.width=(h>0?Math.min(100,scrollY/h*100):0)+'%';t=false;}
  addEventListener('scroll',function(){if(!t){t=true;requestAnimationFrame(upd);}},{passive:true});
  upd();
}`,

  'sticky-nav': `
var top=document.querySelector('.topbar');
if(top){
  var st=false;
  function onS(){top.classList.toggle('stuck',scrollY>24);st=false;}
  addEventListener('scroll',function(){if(!st){st=true;requestAnimationFrame(onS);}},{passive:true});
  onS();
}`,

  parallax: `
var layers=document.querySelectorAll('.backdrop i');
if(layers.length){
  addEventListener('pointermove',function(ev){
    var x=ev.clientX/innerWidth-.5,y=ev.clientY/innerHeight-.5;
    requestAnimationFrame(function(){
      for(var i=0;i<layers.length;i++){
        var d=(i+1)*13;
        layers[i].style.translate=(x*d).toFixed(1)+'px '+(y*d).toFixed(1)+'px';
      }
    });
  },{passive:true});
}`,

  tilt: `
var tilts=document.querySelectorAll('[data-t=tilt]');
if(tilts.length){
  addEventListener('pointermove',function(ev){
    var x=ev.clientX/innerWidth-.5,y=ev.clientY/innerHeight-.5;
    requestAnimationFrame(function(){
      for(var j=0;j<tilts.length;j++){
        tilts[j].style.setProperty('--ry',(x*7).toFixed(2)+'deg');
        tilts[j].style.setProperty('--rx',(-y*7).toFixed(2)+'deg');
      }
    });
  },{passive:true});
}`,

  'pointer-glow': `
document.addEventListener('pointermove',function(ev){
  var c=ev.target.closest&&ev.target.closest('.glow');
  if(!c)return;
  var r=c.getBoundingClientRect();
  c.style.setProperty('--mx',(ev.clientX-r.left)+'px');
  c.style.setProperty('--my',(ev.clientY-r.top)+'px');
},{passive:true});`,

  counters: `
var nums=document.querySelectorAll('[data-count]');
if(nums.length){
  var nio=new IntersectionObserver(function(es){es.forEach(function(e){
    if(!e.isIntersecting)return;
    nio.unobserve(e.target);
    var raw=e.target.textContent,m=raw.match(new RegExp('[0-9.,]+'));
    if(!m)return;
    var target=parseFloat(m[0].replace(new RegExp(',','g'),''));
    if(!isFinite(target))return;
    var dec=(m[0].split('.')[1]||'').length,t0=0;
    function step(ts){
      if(!t0)t0=ts;
      var k=Math.min(1,(ts-t0)/1100),eased=1-Math.pow(1-k,3);
      e.target.textContent=raw.replace(m[0],(target*eased).toFixed(dec));
      if(k<1)requestAnimationFrame(step);else e.target.textContent=raw;
    }
    requestAnimationFrame(step);
  });},{threshold:.5});
  nums.forEach(function(n){nio.observe(n);});
}`,

  marquee: `
document.querySelectorAll('.marquee-track').forEach(function(tr){
  if(tr.dataset.cloned)return;
  tr.dataset.cloned='1';
  tr.innerHTML=tr.innerHTML+tr.innerHTML;
});`,

  faq: `
document.querySelectorAll('.faq-item').forEach(function(d){
  d.addEventListener('toggle',function(){
    if(!d.open)return;
    d.parentElement.querySelectorAll('.faq-item[open]').forEach(function(o){if(o!==d)o.open=false;});
  });
});`,
};

/**
 * Assemble the script.
 *
 * Effects that move things are skipped outright when the visitor asked for
 * reduced motion — cheaper and more honest than animating and then overriding
 * it in CSS.
 */
export function clientJs(slug: string, defaultLang: 'ar' | 'en', effects: string[]): string {
  const motionEffects = new Set(['parallax', 'tilt', 'counters', 'marquee']);
  const blocks = effects
    .filter((id) => EFFECT_JS[id])
    .map((id) => {
      const body = EFFECT_JS[id];
      const guarded = motionEffects.has(id) ? `if(!CALM){${body}\n}` : body;
      return `try{${guarded}}catch(e){}`;
    })
    .join('\n');
  return `(function(){
var CALM=false;
try{CALM=matchMedia('(prefers-reduced-motion: reduce)').matches;}catch(e){}
${coreJs(slug, defaultLang)}
${blocks}
})();`;
}
