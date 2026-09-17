/**
 * The way back into the app, for somebody who is already in it.
 *
 * An academy page is written for a stranger: every call to action on it says
 * "sign up". A student who is already signed in and is browsing teachers hits
 * the same wall — "ابدأ الآن" sends them to a registration form for an account
 * they have, and there is no button anywhere on the page that opens the
 * teacher's courses. The only way through was to register again.
 *
 * So the page adjusts itself once it loads: if this browser has a session, the
 * sign-up buttons become "see their courses" and point at `/t/<slug>` inside
 * the app, and the "log in" link — which is now nonsense — is removed.
 *
 * Done here, at serve time, rather than in the page template on purpose. Every
 * academy page already published keeps its stored HTML until it is regenerated,
 * and some are hand-authored and never regenerate at all (`htmlLocked`). Adding
 * it to the template would have fixed the pages nobody has visited yet and left
 * every live one exactly as it is.
 *
 * The slug is read out of the path rather than templated in, and the match is
 * NOT anchored: the app embeds this page in an iframe whose src is
 * `/api/v1/a/<slug>`, so a pattern pinned to the start of the path would never
 * fire on the one place it actually runs. Same origin either way, which is what
 * lets it see the session at all.
 *
 * The script is deliberately small, defensive and silent: a page that cannot
 * read storage, or that has no call to action, is left as it was. It never
 * decides anything about the session — it reads a token's presence to choose a
 * link, and `/t/<slug>` is behind the app's own guard regardless.
 */

/** Rewritten in place; the icon inside a button survives, only words change. */
const SCRIPT = `<script>(function(){try{
var raw=localStorage.getItem('darsly-auth');if(!raw)return;
var s=(JSON.parse(raw)||{}).state||{};if(!s.accessToken||!s.user)return;
var m=location.pathname.match(/\\/a\\/([^\\/?#]+)/);if(!m)return;
var to='/t/'+m[1];
var en=(document.documentElement.getAttribute('lang')||'').slice(0,2)==='en';
var label=en?'View their courses':'شوف دوراته';
var links=document.querySelectorAll('a[href^="/register"],a[href^="/login"]');
for(var i=0;i<links.length;i++){var a=links[i];
if(a.getAttribute('href').indexOf('/login')===0){a.parentNode&&a.parentNode.removeChild(a);continue;}
a.setAttribute('href',to);a.setAttribute('target','_top');
var done=false;
for(var j=a.childNodes.length-1;j>=0;j--){var n=a.childNodes[j];
if(n.nodeType===3&&n.nodeValue.trim()){if(done){a.removeChild(n);}else{n.nodeValue=label;done=true;}}}
if(!done){a.appendChild(document.createTextNode(label));}}
}catch(e){}})();</script>`;

/**
 * The page with that behaviour added, or the page untouched when there is
 * nowhere sensible to put it.
 */
export function withSignedInCta(html: string): string {
  if (!html) return html;
  // Never twice: a page regenerated from a template that already carries it.
  if (html.includes("localStorage.getItem('darsly-auth')")) return html;
  const close = html.lastIndexOf('</body>');
  if (close === -1) return html + SCRIPT;
  return html.slice(0, close) + SCRIPT + html.slice(close);
}
