// Template of compare.html (main vs branch real-Obsidian screenshots). __DATA__ is replaced by render-index.mjs with
// JSON ({main, list}) whose "<", ">" and "&" are \u-escaped. The script builds the DOM with textContent only (branch names/titles are untrusted).
export const COMPARE_HTML = `<!doctype html>
<html lang="ja"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>mainと比較 - Vault Gantt</title>
<style>
:root{color-scheme:light dark;--bg:#f6f7f9;--fg:#1c1f24;--card:#fff;--line:#d9dde3;--mut:#5b6572;--acc:#2a6df4}
@media (prefers-color-scheme:dark){:root{--bg:#14161a;--fg:#e6e8eb;--card:#1e2126;--line:#33383f;--mut:#98a2af;--acc:#6b9bff}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.6 system-ui,-apple-system,"Hiragino Sans","Noto Sans JP",sans-serif}
main{max-width:80rem;margin:0 auto;padding:16px}
a{color:var(--acc)}h1{font-size:1.3rem;margin:8px 0 4px}h2{font-size:1.05rem;margin:0 0 8px}
.sub{color:var(--mut);font-size:.9rem;margin:0 0 12px;overflow-wrap:anywhere}
.bar{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin:8px 0 16px}
select,.seg button{font:inherit;min-height:44px;border-radius:10px;border:1px solid var(--line);background:var(--card);color:var(--fg);padding:0 12px}
select{flex:1 1 14rem;min-width:0}
.seg{display:inline-flex}.seg button{border-radius:0;margin-left:-1px}.seg button:first-child{border-radius:10px 0 0 10px;margin:0}.seg button:last-child{border-radius:0 10px 10px 0}
.seg button[aria-pressed=true]{background:var(--acc);border-color:var(--acc);color:#fff}
@media (prefers-color-scheme:dark){.seg button[aria-pressed=true]{color:#0b1020}}
section{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:12px;margin:0 0 16px}
.pair{display:grid;grid-template-columns:1fr 1fr;gap:12px}
@media (max-width:700px){.pair{grid-template-columns:1fr}}
figure{margin:0;min-width:0}figcaption{font-size:.85rem;color:var(--mut);margin-bottom:4px;font-weight:700;overflow-wrap:anywhere}
figure img{display:block;width:100%;height:auto;border:1px solid var(--line);border-radius:8px}
.none{padding:24px 8px;color:var(--mut);border:1px dashed var(--line);border-radius:8px;text-align:center}
.flip .seg{margin-bottom:8px}.flip img{cursor:pointer}
.msg{padding:24px 0;color:var(--mut)}
</style></head><body><main>
<a href="./">&larr; 一覧に戻る</a>
<h1>mainと比較</h1>
<p class="sub" id="sub"></p>
<div class="bar" id="bar"></div>
<div id="out"></div>
</main>
<script>
(function(){
var D=__DATA__,out=document.getElementById("out"),bar=document.getElementById("bar"),sub=document.getElementById("sub");
function el(t,p,x){var e=document.createElement(t);if(p)for(var k in p){if(k==="text")e.textContent=p[k];else e.setAttribute(k,p[k])}(x||[]).forEach(function(c){e.appendChild(c)});return e}
function q(k){var m=new RegExp("[?&]"+k+"=([^&]*)").exec(location.search);return m?decodeURIComponent(m[1].replace(/\\+/g," ")):""}
function label(t){return t.branch+(t.pr?" (#"+t.pr.number+" "+t.pr.title+")":"")}
var slug=q("b"),theme=null,mode=null;
try{theme=localStorage.getItem("vgc:theme");mode=localStorage.getItem("vgc:mode")}catch(e){}
if(theme!=="light"&&theme!=="dark")theme=matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light";
if(mode!=="side"&&mode!=="flip")mode="side";
function save(k,v){try{localStorage.setItem(k,v)}catch(e){}}
var cur=D.list.filter(function(t){return t.slug===slug})[0]||null;
function seg(opts,val,on){var s=el("div",{class:"seg",role:"group"});opts.forEach(function(o){var b=el("button",{type:"button",text:o[1],"aria-pressed":String(o[0]===val)});b.addEventListener("click",function(){on(o[0])});s.appendChild(b)});return s}
function get(path){return fetch(path,{cache:"no-cache"}).then(function(r){if(!r.ok)throw new Error(r.status);return r.json()})}
function draw(m,b){
  bar.textContent="";
  var sel=el("select",{"aria-label":"比較するブランチ"});
  D.list.forEach(function(t){var o=el("option",{value:t.slug,text:label(t)});if(cur&&t.slug===cur.slug)o.selected=true;sel.appendChild(o)});
  sel.addEventListener("change",function(){location.search="?b="+encodeURIComponent(sel.value)});
  bar.appendChild(sel);
  bar.appendChild(seg([["light","ライト"],["dark","ダーク"]],theme,function(v){theme=v;save("vgc:theme",v);draw(m,b)}));
  bar.appendChild(seg([["side","並べて表示"],["flip","タップで切替"]],mode,function(v){mode=v;save("vgc:mode",v);draw(m,b)}));
  out.textContent="";
  var names=[],seen={};
  m.views.concat(b.views).forEach(function(v){if(!seen[v.name]){seen[v.name]=1;names.push(v.name)}});
  names.forEach(function(n){
    var mv=m.views.filter(function(v){return v.name===n})[0],bv=b.views.filter(function(v){return v.name===n})[0];
    var mf=mv&&mv.files[theme],bf=bv&&bv.files[theme];
    function fig(cap,slugX,f){return el("figure",null,[el("figcaption",{text:cap}),f?el("img",{src:"b/"+encodeURIComponent(slugX)+"/shots/"+f,alt:cap+" "+n,loading:"lazy"}):el("div",{class:"none",text:"撮影なし"})])}
    var sec=el("section",null,[el("h2",{text:n})]);
    var mc="main",bc=cur.branch;
    if(mode==="side"){sec.appendChild(el("div",{class:"pair"},[fig(mc,D.main.slug,mf),fig(bc,cur.slug,bf)]))}
    else{
      var showB=false,box=el("div",{class:"flip"}),holder=el("div");
      var render=function(){holder.textContent="";holder.appendChild(showB?fig(bc,cur.slug,bf):fig(mc,D.main.slug,mf));box.querySelectorAll("button").forEach(function(x,i){x.setAttribute("aria-pressed",String((i===1)===showB))})};
      var s=el("div",{class:"seg",role:"group"});
      [["main",false],[bc,true]].forEach(function(o){var bt=el("button",{type:"button",text:o[0]==="main"?"main":"ブランチ"});bt.addEventListener("click",function(){showB=o[1];render()});s.appendChild(bt)});
      box.appendChild(s);box.appendChild(holder);
      holder.addEventListener("click",function(e){if(e.target.tagName==="IMG"){showB=!showB;render()}});
      render();sec.appendChild(box);
    }
    out.appendChild(sec);
  });
  if(!names.length)out.appendChild(el("p",{class:"msg",text:"比較できるスクリーンショットがありません。"}));
}
if(!D.main){sub.textContent="mainの実機スクショがまだ無いため比較できません。";}
else if(!cur){
  sub.textContent=slug?"指定されたブランチが見つかりません。下の一覧から選んでください。":"比較するブランチを選んでください。";
  D.list.forEach(function(t){out.appendChild(el("p",null,[el("a",{href:"?b="+encodeURIComponent(t.slug),text:label(t)})]))});
  if(!D.list.length)out.appendChild(el("p",{class:"msg",text:"実機スクショのあるブランチがありません。"}));
}else{
  sub.textContent="main ("+D.main.sha+") と "+cur.branch+" の実機Obsidianスクショ。";
  Promise.all([get("b/"+encodeURIComponent(D.main.slug)+"/shots/shots.json"),get("b/"+encodeURIComponent(cur.slug)+"/shots/shots.json")]).then(function(r){draw(r[0],r[1])}).catch(function(){out.appendChild(el("p",{class:"msg",text:"スクショ情報を読み込めませんでした(再ビルド待ちの可能性があります)。"}))});
}
})();
</script></body></html>
`;
