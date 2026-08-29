import{H as e,U as t,V as n,W as r,a as i,i as a,o,s}from"./file-viewer-archive-CsqKyXJI.js";function c(e,t){(t==null||t>e.length)&&(t=e.length);for(var n=0,r=Array(t);n<t;n++)r[n]=e[n];return r}function l(e){if(Array.isArray(e))return e}function u(e,t){var n=e==null?null:typeof Symbol<`u`&&e[Symbol.iterator]||e[`@@iterator`];if(n!=null){var r,i,a,o,s=[],c=!0,l=!1;try{if(a=(n=n.call(e)).next,t!==0)for(;!(c=(r=a.call(n)).done)&&(s.push(r.value),s.length!==t);c=!0);}catch(e){l=!0,i=e}finally{try{if(!c&&n.return!=null&&(o=n.return(),Object(o)!==o))return}finally{if(l)throw i}}return s}}function d(){throw TypeError(`Invalid attempt to destructure non-iterable instance.
In order to be iterable, non-array objects must have a [Symbol.iterator]() method.`)}function f(e,t){return l(e)||u(e,t)||p(e,t)||d()}function p(e,t){if(e){if(typeof e==`string`)return c(e,t);var n={}.toString.call(e).slice(8,-1);return n===`Object`&&e.constructor&&(n=e.constructor.name),n===`Map`||n===`Set`?Array.from(e):n===`Arguments`||/^(?:Ui|I)nt(?:8|16|32)(?:Clamped)?Array$/.test(n)?c(e,t):void 0}}var m=Object.entries,ee=Object.setPrototypeOf,h=Object.isFrozen,g=Object.getPrototypeOf,te=Object.getOwnPropertyDescriptor,_=Object.freeze,v=Object.seal,ne=Object.create,re=typeof Reflect<`u`&&Reflect,y=re.apply,b=re.construct;_||=function(e){return e},v||=function(e){return e},y||=function(e,t){var n=[...arguments].slice(2);return e.apply(t,n)},b||=function(e){return new e(...[...arguments].slice(1))};var ie=O(Array.prototype.forEach),ae=O(Array.prototype.lastIndexOf),oe=O(Array.prototype.pop),x=O(Array.prototype.push),se=O(Array.prototype.splice),S=Array.isArray,ce=O(String.prototype.toLowerCase),le=O(String.prototype.toString),ue=O(String.prototype.match),de=O(String.prototype.replace),fe=O(String.prototype.indexOf),pe=O(String.prototype.trim),me=O(Number.prototype.toString),C=O(Boolean.prototype.toString),w=typeof BigInt>`u`?null:O(BigInt.prototype.toString),he=typeof Symbol>`u`?null:O(Symbol.prototype.toString),T=O(Object.prototype.hasOwnProperty),ge=O(Object.prototype.toString),E=O(RegExp.prototype.test),D=_e(TypeError);function O(e){return function(t){t instanceof RegExp&&(t.lastIndex=0);var n=[...arguments].slice(1);return y(e,t,n)}}function _e(e){return function(){return b(e,[...arguments])}}function k(e,t){let n=arguments.length>2&&arguments[2]!==void 0?arguments[2]:ce;if(ee&&ee(e,null),!S(t))return e;let r=t.length;for(;r--;){let i=t[r];if(typeof i==`string`){let e=n(i);e!==i&&(h(t)||(t[r]=e),i=e)}e[i]=!0}return e}function A(e){for(let t=0;t<e.length;t++)T(e,t)||(e[t]=null);return e}function j(e){let t=ne(null);for(let r of m(e)){var n=f(r,2);let i=n[0],a=n[1];T(e,i)&&(t[i]=S(a)?A(a):a&&typeof a==`object`&&a.constructor===Object?j(a):a)}return t}function ve(e){switch(typeof e){case`string`:return e;case`number`:return me(e);case`boolean`:return C(e);case`bigint`:return w?w(e):`0`;case`symbol`:return he?he(e):`Symbol()`;case`undefined`:return ge(e);case`function`:case`object`:{if(e===null)return ge(e);let t=e,n=M(t,`toString`);if(typeof n==`function`){let e=n(t);return typeof e==`string`?e:ge(e)}return ge(e)}default:return ge(e)}}function M(e,t){for(;e!==null;){let n=te(e,t);if(n){if(n.get)return O(n.get);if(typeof n.value==`function`)return O(n.value)}e=g(e)}function n(){return null}return n}function ye(e){try{return E(e,``),!0}catch{return!1}}var be=_(`a.abbr.acronym.address.area.article.aside.audio.b.bdi.bdo.big.blink.blockquote.body.br.button.canvas.caption.center.cite.code.col.colgroup.content.data.datalist.dd.decorator.del.details.dfn.dialog.dir.div.dl.dt.element.em.fieldset.figcaption.figure.font.footer.form.h1.h2.h3.h4.h5.h6.head.header.hgroup.hr.html.i.img.input.ins.kbd.label.legend.li.main.map.mark.marquee.menu.menuitem.meter.nav.nobr.ol.optgroup.option.output.p.picture.pre.progress.q.rp.rt.ruby.s.samp.search.section.select.shadow.slot.small.source.spacer.span.strike.strong.style.sub.summary.sup.table.tbody.td.template.textarea.tfoot.th.thead.time.tr.track.tt.u.ul.var.video.wbr`.split(`.`)),xe=_(`svg.a.altglyph.altglyphdef.altglyphitem.animatecolor.animatemotion.animatetransform.circle.clippath.defs.desc.ellipse.enterkeyhint.exportparts.filter.font.g.glyph.glyphref.hkern.image.inputmode.line.lineargradient.marker.mask.metadata.mpath.part.path.pattern.polygon.polyline.radialgradient.rect.stop.style.switch.symbol.text.textpath.title.tref.tspan.view.vkern`.split(`.`)),Se=_([`feBlend`,`feColorMatrix`,`feComponentTransfer`,`feComposite`,`feConvolveMatrix`,`feDiffuseLighting`,`feDisplacementMap`,`feDistantLight`,`feDropShadow`,`feFlood`,`feFuncA`,`feFuncB`,`feFuncG`,`feFuncR`,`feGaussianBlur`,`feImage`,`feMerge`,`feMergeNode`,`feMorphology`,`feOffset`,`fePointLight`,`feSpecularLighting`,`feSpotLight`,`feTile`,`feTurbulence`]),Ce=_([`animate`,`color-profile`,`cursor`,`discard`,`font-face`,`font-face-format`,`font-face-name`,`font-face-src`,`font-face-uri`,`foreignobject`,`hatch`,`hatchpath`,`mesh`,`meshgradient`,`meshpatch`,`meshrow`,`missing-glyph`,`script`,`set`,`solidcolor`,`unknown`,`use`]),we=_(`math.menclose.merror.mfenced.mfrac.mglyph.mi.mlabeledtr.mmultiscripts.mn.mo.mover.mpadded.mphantom.mroot.mrow.ms.mspace.msqrt.mstyle.msub.msup.msubsup.mtable.mtd.mtext.mtr.munder.munderover.mprescripts`.split(`.`)),Te=_([`maction`,`maligngroup`,`malignmark`,`mlongdiv`,`mscarries`,`mscarry`,`msgroup`,`mstack`,`msline`,`msrow`,`semantics`,`annotation`,`annotation-xml`,`mprescripts`,`none`]),Ee=_([`#text`]),De=_(`accept.action.align.alt.autocapitalize.autocomplete.autopictureinpicture.autoplay.background.bgcolor.border.capture.cellpadding.cellspacing.checked.cite.class.clear.color.cols.colspan.command.commandfor.controls.controlslist.coords.crossorigin.datetime.decoding.default.dir.disabled.disablepictureinpicture.disableremoteplayback.download.draggable.enctype.enterkeyhint.exportparts.face.for.headers.height.hidden.high.href.hreflang.id.inert.inputmode.integrity.ismap.kind.label.lang.list.loading.loop.low.max.maxlength.media.method.min.minlength.multiple.muted.name.nonce.noshade.novalidate.nowrap.open.optimum.part.pattern.placeholder.playsinline.popover.popovertarget.popovertargetaction.poster.preload.pubdate.radiogroup.readonly.rel.required.rev.reversed.role.rows.rowspan.spellcheck.scope.selected.shape.size.sizes.slot.span.srclang.start.src.srcset.step.style.summary.tabindex.title.translate.type.usemap.valign.value.width.wrap.xmlns`.split(`.`)),Oe=_(`accent-height.accumulate.additive.alignment-baseline.amplitude.ascent.attributename.attributetype.azimuth.basefrequency.baseline-shift.begin.bias.by.class.clip.clippathunits.clip-path.clip-rule.color.color-interpolation.color-interpolation-filters.color-profile.color-rendering.cx.cy.d.dx.dy.diffuseconstant.direction.display.divisor.dominant-baseline.dur.edgemode.elevation.end.exponent.fill.fill-opacity.fill-rule.filter.filterunits.flood-color.flood-opacity.font-family.font-size.font-size-adjust.font-stretch.font-style.font-variant.font-weight.fx.fy.g1.g2.glyph-name.glyphref.gradientunits.gradienttransform.height.href.id.image-rendering.in.in2.intercept.k.k1.k2.k3.k4.kerning.keypoints.keysplines.keytimes.lang.lengthadjust.letter-spacing.kernelmatrix.kernelunitlength.lighting-color.local.marker-end.marker-mid.marker-start.markerheight.markerunits.markerwidth.maskcontentunits.maskunits.max.mask.mask-type.media.method.mode.min.name.numoctaves.offset.operator.opacity.order.orient.orientation.origin.overflow.paint-order.path.pathlength.patterncontentunits.patterntransform.patternunits.points.preservealpha.preserveaspectratio.primitiveunits.r.rx.ry.radius.refx.refy.repeatcount.repeatdur.restart.result.rotate.scale.seed.shape-rendering.slope.specularconstant.specularexponent.spreadmethod.startoffset.stddeviation.stitchtiles.stop-color.stop-opacity.stroke-dasharray.stroke-dashoffset.stroke-linecap.stroke-linejoin.stroke-miterlimit.stroke-opacity.stroke.stroke-width.style.surfacescale.systemlanguage.tabindex.tablevalues.targetx.targety.transform.transform-origin.text-anchor.text-decoration.text-orientation.text-rendering.textlength.type.u1.u2.unicode.values.viewbox.visibility.version.vert-adv-y.vert-origin-x.vert-origin-y.width.word-spacing.wrap.writing-mode.xchannelselector.ychannelselector.x.x1.x2.xmlns.y.y1.y2.z.zoomandpan`.split(`.`)),ke=_(`accent.accentunder.align.bevelled.close.columnalign.columnlines.columnspacing.columnspan.denomalign.depth.dir.display.displaystyle.encoding.fence.frame.height.href.id.largeop.length.linethickness.lquote.lspace.mathbackground.mathcolor.mathsize.mathvariant.maxsize.minsize.movablelimits.notation.numalign.open.rowalign.rowlines.rowspacing.rowspan.rspace.rquote.scriptlevel.scriptminsize.scriptsizemultiplier.selection.separator.separators.stretchy.subscriptshift.supscriptshift.symmetric.voffset.width.xmlns`.split(`.`)),Ae=_([`xlink:href`,`xml:id`,`xlink:title`,`xml:space`,`xmlns:xlink`]),je=v(/{{[\w\W]*|^[\w\W]*}}/g),Me=v(/<%[\w\W]*|^[\w\W]*%>/g),Ne=v(/\${[\w\W]*/g),Pe=v(/^data-[\-\w.\u00B7-\uFFFF]+$/),Fe=v(/^aria-[\-\w]+$/),Ie=v(/^(?:(?:(?:f|ht)tps?|mailto|tel|callto|sms|cid|xmpp|matrix):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i),Le=v(/^(?:\w+script|data):/i),Re=v(/[\u0000-\u0020\u00A0\u1680\u180E\u2000-\u2029\u205F\u3000]/g),ze=v(/^html$/i),Be=v(/^[a-z][.\w]*(-[.\w]+)+$/i),Ve=v(/<[/\w!]/g),He=v(/<[/\w]/g),Ue=v(/<\/no(script|embed|frames)/i),We=v(/\/>/i),N={element:1,attribute:2,text:3,cdataSection:4,entityReference:5,entityNode:6,processingInstruction:7,comment:8,document:9,documentType:10,documentFragment:11,notation:12},Ge=function(){return typeof window>`u`?null:window},Ke=function(e,t){if(typeof e!=`object`||typeof e.createPolicy!=`function`)return null;let n=null,r=`data-tt-policy-suffix`;t&&t.hasAttribute(r)&&(n=t.getAttribute(r));let i=`dompurify`+(n?`#`+n:``);try{return e.createPolicy(i,{createHTML(e){return e},createScriptURL(e){return e}})}catch{return console.warn(`TrustedTypes policy `+i+` could not be created.`),null}},qe=function(){return{afterSanitizeAttributes:[],afterSanitizeElements:[],afterSanitizeShadowDOM:[],beforeSanitizeAttributes:[],beforeSanitizeElements:[],beforeSanitizeShadowDOM:[],uponSanitizeAttribute:[],uponSanitizeElement:[],uponSanitizeShadowNode:[]}},P=function(e,t,n,r){return T(e,t)&&S(e[t])?k(r.base?j(r.base):{},e[t],r.transform):n};function Je(){let e=arguments.length>0&&arguments[0]!==void 0?arguments[0]:Ge(),t=e=>Je(e);if(t.version=`3.4.13`,t.removed=[],!e||!e.document||e.document.nodeType!==N.document||!e.Element)return t.isSupported=!1,t;let n=e.document,r=n,i=r.currentScript;e.DocumentFragment;let a=e.HTMLTemplateElement,o=e.Node,s=e.Element,c=e.NodeFilter;e.NamedNodeMap===void 0&&(e.NamedNodeMap||e.MozNamedAttrMap),e.HTMLFormElement;let l=e.DOMParser,u=e.trustedTypes,d=s.prototype,f=M(d,`cloneNode`),p=M(d,`remove`),ee=M(d,`nextSibling`),h=M(d,`childNodes`),g=M(d,`parentNode`),te=M(d,`shadowRoot`),re=M(d,`attributes`),y=o&&o.prototype?M(o.prototype,`nodeType`):null,b=o&&o.prototype?M(o.prototype,`nodeName`):null,me=o&&o.prototype?M(o.prototype,`ownerDocument`):null;if(typeof a==`function`){let e=n.createElement(`template`);e.content&&e.content.ownerDocument&&(n=e.content.ownerDocument)}let C,w=``,he,ge=!1,O=0,_e=function(){if(O>0)throw D(`A configured TRUSTED_TYPES_POLICY callback (createHTML or createScriptURL) must not call DOMPurify.sanitize, as that causes infinite recursion. Do not pass a policy whose callbacks wrap DOMPurify as TRUSTED_TYPES_POLICY; see the "DOMPurify and Trusted Types" section of the README.`)},A=function(e){_e(),O++;try{return C.createHTML(e)}finally{O--}},Ye=function(e){_e(),O++;try{return C.createScriptURL(e)}finally{O--}},Xe=function(){return ge||=(he=Ke(u,i),!0),he},Ze=n,F=Ze.implementation,Qe=Ze.createNodeIterator,$e=Ze.createDocumentFragment,et=Ze.getElementsByTagName,tt=r.importNode,I=qe();t.isSupported=typeof m==`function`&&typeof g==`function`&&F&&F.createHTMLDocument!==void 0;let nt=je,rt=Me,it=Ne,at=Pe,L=Fe,ot=Le,st=Re,ct=Be,lt=Ie,R=null,ut=k({},[...be,...xe,...Se,...we,...Ee]),z=null,dt=k({},[...De,...Oe,...ke,...Ae]),B=Object.seal(ne(null,{tagNameCheck:{writable:!0,configurable:!1,enumerable:!0,value:null},attributeNameCheck:{writable:!0,configurable:!1,enumerable:!0,value:null},allowCustomizedBuiltInElements:{writable:!0,configurable:!1,enumerable:!0,value:!1}})),V=null,ft=null,H=Object.seal(ne(null,{tagCheck:{writable:!0,configurable:!1,enumerable:!0,value:null},attributeCheck:{writable:!0,configurable:!1,enumerable:!0,value:null}})),pt=!0,mt=!0,ht=!1,gt=!0,U=!1,W=!0,G=!1,_t=!1,vt=null,yt=null,bt=!1,K=!1,xt=!1,St=!1,Ct=!0,wt=!1,Tt=`user-content-`,Et=!0,Dt=!1,Ot={},q=null,kt=k({},`annotation-xml.audio.colgroup.desc.foreignobject.head.iframe.math.mi.mn.mo.ms.mtext.noembed.noframes.noscript.plaintext.script.selectedcontent.style.svg.template.thead.title.video.xmp`.split(`.`)),At=null,jt=k({},[`audio`,`video`,`img`,`source`,`image`,`track`]),Mt=null,Nt=k({},[`alt`,`class`,`for`,`id`,`label`,`name`,`pattern`,`placeholder`,`role`,`summary`,`title`,`value`,`style`,`xmlns`]),Pt=`http://www.w3.org/1998/Math/MathML`,Ft=`http://www.w3.org/2000/svg`,J=`http://www.w3.org/1999/xhtml`,It=J,Lt=!1,Rt=null,zt=k({},[Pt,Ft,J],le),Bt=_([`mi`,`mo`,`mn`,`ms`,`mtext`]),Vt=k({},Bt),Ht=_([`annotation-xml`]),Ut=k({},Ht),Wt=k({},[`title`,`style`,`font`,`a`,`script`]),Gt=null,Kt=[`application/xhtml+xml`,`text/html`],Y=null,qt=null,Jt=n.createElement(`form`),Yt=function(e){return e instanceof RegExp||e instanceof Function},Xt=function(){let e=arguments.length>0&&arguments[0]!==void 0?arguments[0]:{};if(qt&&qt===e)return;(!e||typeof e!=`object`)&&(e={}),e=j(e),Gt=Kt.indexOf(e.PARSER_MEDIA_TYPE)===-1?`text/html`:e.PARSER_MEDIA_TYPE,Y=Gt===`application/xhtml+xml`?le:ce,R=P(e,`ALLOWED_TAGS`,ut,{transform:Y}),z=P(e,`ALLOWED_ATTR`,dt,{transform:Y}),Rt=P(e,`ALLOWED_NAMESPACES`,zt,{transform:le}),Mt=P(e,`ADD_URI_SAFE_ATTR`,Nt,{transform:Y,base:Nt}),At=P(e,`ADD_DATA_URI_TAGS`,jt,{transform:Y,base:jt}),q=P(e,`FORBID_CONTENTS`,kt,{transform:Y}),V=P(e,`FORBID_TAGS`,j({}),{transform:Y}),ft=P(e,`FORBID_ATTR`,j({}),{transform:Y}),Ot=T(e,`USE_PROFILES`)?e.USE_PROFILES&&typeof e.USE_PROFILES==`object`?j(e.USE_PROFILES):e.USE_PROFILES:!1,pt=e.ALLOW_ARIA_ATTR!==!1,mt=e.ALLOW_DATA_ATTR!==!1,ht=e.ALLOW_UNKNOWN_PROTOCOLS||!1,gt=e.ALLOW_SELF_CLOSE_IN_ATTR!==!1,U=e.SAFE_FOR_TEMPLATES||!1,W=e.SAFE_FOR_XML!==!1,G=e.WHOLE_DOCUMENT||!1,K=e.RETURN_DOM||!1,xt=e.RETURN_DOM_FRAGMENT||!1,St=e.RETURN_TRUSTED_TYPE||!1,bt=e.FORCE_BODY||!1,Ct=e.SANITIZE_DOM!==!1,wt=e.SANITIZE_NAMED_PROPS||!1,Et=e.KEEP_CONTENT!==!1,Dt=e.IN_PLACE||!1,lt=ye(e.ALLOWED_URI_REGEXP)?e.ALLOWED_URI_REGEXP:Ie,It=typeof e.NAMESPACE==`string`?e.NAMESPACE:J,Vt=T(e,`MATHML_TEXT_INTEGRATION_POINTS`)&&e.MATHML_TEXT_INTEGRATION_POINTS&&typeof e.MATHML_TEXT_INTEGRATION_POINTS==`object`?j(e.MATHML_TEXT_INTEGRATION_POINTS):k({},Bt),Ut=T(e,`HTML_INTEGRATION_POINTS`)&&e.HTML_INTEGRATION_POINTS&&typeof e.HTML_INTEGRATION_POINTS==`object`?j(e.HTML_INTEGRATION_POINTS):k({},Ht);let t=T(e,`CUSTOM_ELEMENT_HANDLING`)&&e.CUSTOM_ELEMENT_HANDLING&&typeof e.CUSTOM_ELEMENT_HANDLING==`object`?j(e.CUSTOM_ELEMENT_HANDLING):ne(null);if(B=ne(null),T(t,`tagNameCheck`)&&Yt(t.tagNameCheck)&&(B.tagNameCheck=t.tagNameCheck),T(t,`attributeNameCheck`)&&Yt(t.attributeNameCheck)&&(B.attributeNameCheck=t.attributeNameCheck),T(t,`allowCustomizedBuiltInElements`)&&typeof t.allowCustomizedBuiltInElements==`boolean`&&(B.allowCustomizedBuiltInElements=t.allowCustomizedBuiltInElements),v(B),U&&(mt=!1),xt&&(K=!0),Ot&&(R=k({},Ee),z=ne(null),Ot.html===!0&&(k(R,be),k(z,De)),Ot.svg===!0&&(k(R,xe),k(z,Oe),k(z,Ae)),Ot.svgFilters===!0&&(k(R,Se),k(z,Oe),k(z,Ae)),Ot.mathMl===!0&&(k(R,we),k(z,ke),k(z,Ae))),H.tagCheck=null,H.attributeCheck=null,T(e,`ADD_TAGS`)&&(typeof e.ADD_TAGS==`function`?H.tagCheck=e.ADD_TAGS:S(e.ADD_TAGS)&&(R===ut&&(R=j(R)),k(R,e.ADD_TAGS,Y))),T(e,`ADD_ATTR`)&&(typeof e.ADD_ATTR==`function`?H.attributeCheck=e.ADD_ATTR:S(e.ADD_ATTR)&&(z===dt&&(z=j(z)),k(z,e.ADD_ATTR,Y))),T(e,`ADD_URI_SAFE_ATTR`)&&S(e.ADD_URI_SAFE_ATTR)&&k(Mt,e.ADD_URI_SAFE_ATTR,Y),T(e,`FORBID_CONTENTS`)&&S(e.FORBID_CONTENTS)&&(q===kt&&(q=j(q)),k(q,e.FORBID_CONTENTS,Y)),T(e,`ADD_FORBID_CONTENTS`)&&S(e.ADD_FORBID_CONTENTS)&&(q===kt&&(q=j(q)),k(q,e.ADD_FORBID_CONTENTS,Y)),Et&&(R[`#text`]=!0),G&&k(R,[`html`,`head`,`body`]),R.table&&(k(R,[`tbody`]),delete V.tbody),e.TRUSTED_TYPES_POLICY){if(typeof e.TRUSTED_TYPES_POLICY.createHTML!=`function`)throw D(`TRUSTED_TYPES_POLICY configuration option must provide a "createHTML" hook.`);if(typeof e.TRUSTED_TYPES_POLICY.createScriptURL!=`function`)throw D(`TRUSTED_TYPES_POLICY configuration option must provide a "createScriptURL" hook.`);let t=C;C=e.TRUSTED_TYPES_POLICY;try{w=A(``)}catch(e){throw C=t,e}}else e.TRUSTED_TYPES_POLICY===null?(C=void 0,w=``):(C===void 0&&(C=Xe()),C&&typeof w==`string`&&(w=A(``)));_&&_(e),qt=e},Zt=k({},[...xe,...Se,...Ce]),Qt=k({},[...we,...Te]),$t=function(e,t,n){return t.namespaceURI===J?e===`svg`:t.namespaceURI===Pt?e===`svg`&&(n===`annotation-xml`||Vt[n]):!!Zt[e]},en=function(e,t,n){return t.namespaceURI===J?e===`math`:t.namespaceURI===Ft?e===`math`&&Ut[n]:!!Qt[e]},tn=function(e,t,n){return t.namespaceURI===Ft&&!Ut[n]||t.namespaceURI===Pt&&!Vt[n]?!1:!Qt[e]&&(Wt[e]||!Zt[e])},nn=function(e){let t=g(e);(!t||!t.tagName)&&(t={namespaceURI:It,tagName:`template`});let n=ce(e.tagName),r=ce(t.tagName);return Rt[e.namespaceURI]?e.namespaceURI===Ft?$t(n,t,r):e.namespaceURI===Pt?en(n,t,r):e.namespaceURI===J?tn(n,t,r):!!(Gt===`application/xhtml+xml`&&Rt[e.namespaceURI]):!1},X=function(e){x(t.removed,{element:e});try{g(e).removeChild(e)}catch{if(p(e),!g(e))throw D(`a node selected for removal could not be detached from its tree and cannot be safely returned; refusing to sanitize in place`)}},rn=function(e){on(e);let t=h(e);if(t){let e=[];ie(t,t=>{x(e,t)}),ie(e,e=>{try{p(e)}catch{}})}let n=re(e);if(n)for(let t=n.length-1;t>=0;--t){let r=n[t],i=r&&r.name;if(typeof i==`string`)try{e.removeAttribute(i)}catch{}}},Z=function(e,n){try{x(t.removed,{attribute:n.getAttributeNode(e),from:n})}catch{x(t.removed,{attribute:null,from:n})}if(n.removeAttribute(e),e===`is`){if(K||xt)try{X(n)}catch{}else try{n.setAttribute(e,``)}catch{}}},an=function(e){let t=re(e);if(t)for(let n=t.length-1;n>=0;--n){let r=t[n],i=r&&r.name;if(!(typeof i!=`string`||z[Y(i)]))try{e.removeAttribute(i)}catch{}}},on=function(e){let t=[e];for(;t.length>0;){let e=t.pop();(y?y(e):e.nodeType)===N.element&&an(e);let n=h(e);if(n)for(let e=n.length-1;e>=0;--e)t.push(n[e])}},sn=function(e){if(!W)return;let t=[e];for(;t.length>0;){let e=t.pop(),n=y?y(e):e.nodeType;if(n===N.processingInstruction||n===N.comment&&E(He,e.data)){try{p(e)}catch{}continue}if(n===N.element){let t=e,n=Y(b?b(e):e.nodeName);try{t.hasAttribute&&t.hasAttribute(`patchsrc`)&&t.removeAttribute(`patchsrc`),t.hasAttribute&&t.hasAttribute(`for`)&&n!==`label`&&n!==`output`&&t.removeAttribute(`for`)}catch{}}let r=h(e);if(r)for(let e=r.length-1;e>=0;--e)t.push(r[e])}},cn=function(e){let t=null,r=null;if(bt)e=`<remove></remove>`+e;else{let t=ue(e,/^[\r\n\t ]+/);r=t&&t[0]}Gt===`application/xhtml+xml`&&It===J&&(e=`<html xmlns="http://www.w3.org/1999/xhtml"><head></head><body>`+e+`</body></html>`);let i=C?A(e):e;if(It===J)try{t=new l().parseFromString(i,Gt)}catch{}if(!t||!t.documentElement){t=F.createDocument(It,`template`,null);try{t.documentElement.innerHTML=Lt?w:i}catch{}}let a=t.body||t.documentElement;return e&&r&&a.insertBefore(n.createTextNode(r),a.childNodes[0]||null),It===J?et.call(t,G?`html`:`body`)[0]:G?t.documentElement:a},ln=function(e){let t=me?me(e):e.ownerDocument;return Qe.call(t||e,e,c.SHOW_ELEMENT|c.SHOW_COMMENT|c.SHOW_TEXT|c.SHOW_PROCESSING_INSTRUCTION|c.SHOW_CDATA_SECTION,null)},un=function(e){return e=de(e,nt,` `),e=de(e,rt,` `),e=de(e,it,` `),e},dn=function(e){e.normalize();let t=me?me(e):e.ownerDocument,n=Qe.call(t||e,e,c.SHOW_TEXT|c.SHOW_COMMENT|c.SHOW_CDATA_SECTION|c.SHOW_PROCESSING_INSTRUCTION,null),r=n.nextNode();for(;r;)r.data=un(r.data),r=n.nextNode();let i=e.querySelectorAll?.call(e,`template`);i&&ie(i,e=>{Q(e.content)&&dn(e.content)})},fn=function(e){let t=b?b(e):null;return typeof t!=`string`||Y(t)!==`form`?!1:typeof e.nodeName!=`string`||typeof e.textContent!=`string`||typeof e.removeChild!=`function`||e.attributes!==re(e)||typeof e.removeAttribute!=`function`||typeof e.setAttribute!=`function`||typeof e.namespaceURI!=`string`||typeof e.insertBefore!=`function`||typeof e.hasChildNodes!=`function`||e.nodeType!==y(e)||e.childNodes!==h(e)},Q=function(e){if(!y||typeof e!=`object`||!e)return!1;try{return y(e)===N.documentFragment}catch{return!1}},pn=function(e){if(!y||typeof e!=`object`||!e)return!1;try{return typeof y(e)==`number`}catch{return!1}};function $(e,n,r){e.length!==0&&ie(e,e=>{e.call(t,n,r,qt)})}let mn=function(e,t){return!!(W&&e.hasChildNodes()&&!pn(e.firstElementChild)&&E(Ve,e.textContent)&&E(Ve,e.innerHTML)||W&&e.namespaceURI===J&&t===`style`&&pn(e.firstElementChild)||e.nodeType===N.processingInstruction||W&&e.nodeType===N.comment&&E(He,e.data))},hn=function(e,t,n){if(!V[t]&&bn(t)&&(B.tagNameCheck instanceof RegExp&&E(B.tagNameCheck,t)||B.tagNameCheck instanceof Function&&B.tagNameCheck(t)))return!1;if(Et&&!q[t]){let t=g(e),r=h(e);if(r&&t){let i=r.length;for(let a=i-1;a>=0;--a){let i=e===n?f(r[a],!0):r[a];t.insertBefore(i,ee(e))}}}return X(e),!0},gn=function(e,t,n,r){return e.length===0?t:t===n||t===r?j(t):t},_n=function(e,n){if($(I.beforeSanitizeElements,e,null),e!==n&&g(e)===null)return Dt&&on(e),!0;if(fn(e))return X(e),!0;let r=Y(b?b(e):e.nodeName);if(R=gn(I.uponSanitizeElement,R,ut,vt),$(I.uponSanitizeElement,e,{tagName:r,allowedTags:R}),e!==n&&g(e)===null)return Dt&&on(e),!0;if(mn(e,r))return X(e),!0;if(V[r]||!(H.tagCheck instanceof Function&&H.tagCheck(r))&&!R[r]){let t=hn(e,r,n);return t===!1&&$(I.afterSanitizeElements,e,null),t}if((y?y(e):e.nodeType)===N.element&&!nn(e)||(r===`noscript`||r===`noembed`||r===`noframes`)&&E(Ue,e.innerHTML))return X(e),!0;if(U&&e.nodeType===N.text){let n=un(e.textContent);e.textContent!==n&&(x(t.removed,{element:e.cloneNode()}),e.textContent=n)}return $(I.afterSanitizeElements,e,null),!1},vn=function(e,t,r){if(ft[t]||W&&t===`patchsrc`||W&&t===`for`&&e!==`label`&&e!==`output`||Ct&&(t===`id`||t===`name`)&&(r in n||r in Jt))return!1;let i=z[t]||H.attributeCheck instanceof Function&&H.attributeCheck(t,e);if(!(mt&&E(at,t))&&!(pt&&E(L,t))){if(!i){if(!(bn(e)&&(B.tagNameCheck instanceof RegExp&&E(B.tagNameCheck,e)||B.tagNameCheck instanceof Function&&B.tagNameCheck(e))&&(B.attributeNameCheck instanceof RegExp&&E(B.attributeNameCheck,t)||B.attributeNameCheck instanceof Function&&B.attributeNameCheck(t,e))||t===`is`&&B.allowCustomizedBuiltInElements&&(B.tagNameCheck instanceof RegExp&&E(B.tagNameCheck,r)||B.tagNameCheck instanceof Function&&B.tagNameCheck(r))))return!1}else if(!Mt[t]&&!E(lt,de(r,st,``))&&!((t===`src`||t===`xlink:href`||t===`href`)&&e!==`script`&&fe(r,`data:`)===0&&At[e])&&!(ht&&!E(ot,de(r,st,``)))&&r)return!1}return!0},yn=k({},[`annotation-xml`,`color-profile`,`font-face`,`font-face-format`,`font-face-name`,`font-face-src`,`font-face-uri`,`missing-glyph`]),bn=function(e){return!yn[ce(e)]&&E(ct,e)},xn=function(e,t,n,r){if(C&&typeof u==`object`&&typeof u.getAttributeType==`function`&&!n)switch(u.getAttributeType(e,t)){case`TrustedHTML`:return A(r);case`TrustedScriptURL`:return Ye(r)}return r},Sn=function(e,n,r,i){try{r?e.setAttributeNS(r,n,i):e.setAttribute(n,i),fn(e)?X(e):oe(t.removed)}catch{Z(n,e)}},Cn=function(e){$(I.beforeSanitizeAttributes,e,null);let t=e.attributes;if(!t||fn(e))return;z=gn(I.uponSanitizeAttribute,z,dt,yt);let n={attrName:``,attrValue:``,keepAttr:!0,allowedAttributes:z,forceKeepAttr:void 0},r=t.length,i=Y(e.nodeName);for(;r--;){let a=t[r],o=a.name,s=a.namespaceURI,c=a.value,l=Y(o),u=c,d=o===`value`?u:pe(u);if(n.attrName=l,n.attrValue=d,n.keepAttr=!0,n.forceKeepAttr=void 0,$(I.uponSanitizeAttribute,e,n),d=n.attrValue,wt&&(l===`id`||l===`name`)&&fe(d,Tt)!==0&&(Z(o,e),d=Tt+d),W&&E(/((--!?|])>)|<\/(style|script|title|xmp|textarea|noscript|iframe|noembed|noframes)/i,d)){Z(o,e);continue}if(l===`attributename`&&ue(d,`href`)){Z(o,e);continue}if(!n.forceKeepAttr){if(!n.keepAttr){Z(o,e);continue}if(!gt&&E(We,d)){Z(o,e);continue}if(U&&(d=un(d)),!vn(i,l,d)){Z(o,e);continue}d=xn(i,l,s,d),d!==u&&Sn(e,o,s,d)}}$(I.afterSanitizeAttributes,e,null)},wn=function(e){let t=null,n=ln(e);for($(I.beforeSanitizeShadowDOM,e,null);t=n.nextNode();)if($(I.uponSanitizeShadowNode,t,null),_n(t,e),Cn(t),Q(t.content)&&wn(t.content),(y?y(t):t.nodeType)===N.element){let e=te(t);Q(e)&&(Tn(e),wn(e))}$(I.afterSanitizeShadowDOM,e,null)},Tn=function(e){let t=[{node:e,shadow:null}];for(;t.length>0;){let e=t.pop();if(e.shadow){wn(e.shadow);continue}let n=e.node,r=(y?y(n):n.nodeType)===N.element,i=h(n);if(i)for(let e=i.length-1;e>=0;--e)t.push({node:i[e],shadow:null});if(r){let e=b?b(n):null;if(typeof e==`string`&&Y(e)===`template`){let e=n.content;Q(e)&&t.push({node:e,shadow:null})}}if(r){let e=te(n);Q(e)&&t.push({node:null,shadow:e},{node:e,shadow:null})}}};return t.sanitize=function(e){let n=arguments.length>1&&arguments[1]!==void 0?arguments[1]:{},i=null,a=null,o=null,s=null;if(Lt=!e,Lt&&(e=`<!-->`),typeof e!=`string`&&!pn(e)&&(e=ve(e),typeof e!=`string`))throw D(`dirty is not a string, aborting`);if(!t.isSupported)return e;_t?(R=vt,z=yt):Xt(n),(I.uponSanitizeElement.length>0||I.uponSanitizeAttribute.length>0)&&(R=j(R)),I.uponSanitizeAttribute.length>0&&(z=j(z)),t.removed=[];let c=Dt&&typeof e!=`string`&&pn(e);if(c){sn(e);let t=b?b(e):e.nodeName;if(typeof t==`string`){let n=Y(t);if(!R[n]||V[n])throw rn(e),D(`root node is forbidden and cannot be sanitized in-place`)}if(fn(e))throw rn(e),D(`root node is clobbered and cannot be sanitized in-place`);try{Tn(e)}catch(t){throw rn(e),t}}else if(pn(e))i=cn(`<!---->`),a=i.ownerDocument.importNode(e,!0),a.nodeType===N.element&&a.nodeName===`BODY`||a.nodeName===`HTML`?i=a:i.appendChild(a),Tn(a);else{if(!K&&!U&&!G&&e.indexOf(`<`)===-1)return C&&St?A(e):e;if(i=cn(e),!i)return K?null:St?w:``}i&&bt&&X(i.firstChild);let l=c?e:i;try{let e=ln(l);for(;o=e.nextNode();)_n(o,l),Cn(o),Q(o.content)&&wn(o.content)}catch(n){throw c&&(rn(e),ie(t.removed,e=>{e.element&&on(e.element)})),n}if(c)return ie(t.removed,e=>{e.element&&on(e.element)}),U&&dn(e),e;if(K){if(U&&dn(i),xt)for(s=$e.call(i.ownerDocument);i.firstChild;)s.appendChild(i.firstChild);else s=i;return(z.shadowroot||z.shadowrootmode)&&(s=tt.call(r,s,!0)),s}let u=G?i.outerHTML:i.innerHTML;return G&&R[`!doctype`]&&i.ownerDocument&&i.ownerDocument.doctype&&i.ownerDocument.doctype.name&&E(ze,i.ownerDocument.doctype.name)&&(u=`<!DOCTYPE `+i.ownerDocument.doctype.name+`>
`+u),U&&(u=un(u)),C&&St?A(u):u},t.setConfig=function(){let e=arguments.length>0&&arguments[0]!==void 0?arguments[0]:{};Xt(e),_t=!0,vt=R,yt=z},t.clearConfig=function(){qt=null,_t=!1,vt=null,yt=null,C=he,w=``},t.isValidAttribute=function(e,t,n){qt||Xt({});let r=Y(e),i=Y(t);return vn(r,i,n)},t.addHook=function(e,t){typeof t==`function`&&T(I,e)&&x(I[e],t)},t.removeHook=function(e,t){if(T(I,e)){if(t!==void 0){let n=ae(I[e],t);return n===-1?void 0:se(I[e],n,1)[0]}return oe(I[e])}},t.removeHooks=function(e){T(I,e)&&(I[e]=[])},t.removeAllHooks=function(){I=qe()},t}var Ye=Je(),Xe=e=>e.replace(/&/g,`&amp;`).replace(/"/g,`&quot;`).replace(/</g,`&lt;`).replace(/>/g,`&gt;`),Ze={WHOLE_DOCUMENT:!0,USE_PROFILES:{html:!0,svg:!0,svgFilters:!0,mathMl:!0},ADD_TAGS:[`use`],ADD_ATTR:[`target`,`rel`,`download`],FORBID_TAGS:[`script`,`iframe`,`object`,`embed`,`base`,`form`,`link`],FORBID_ATTR:[`srcdoc`]},F=e=>e||globalThis.document||null,Qe=e=>/[A-Za-z0-9_-]/.test(e),$e=(e,t)=>{let n=t+1,r=e[n]||``;if(!r)return{value:``,nextIndex:n};if(r===`\r`||r===`
`||r===`\f`)return r===`\r`&&e[n+1]===`
`&&(n+=1),{value:``,nextIndex:n+1};let i=``;for(;n<e.length&&i.length<6&&/[0-9a-f]/i.test(e[n]||``);)i+=e[n],n+=1;if(i){/\s/.test(e[n]||``)&&(n+=1);let t=Number.parseInt(i,16);return{value:t===0||t>1114111?`�`:String.fromCodePoint(t),nextIndex:n}}return{value:r,nextIndex:n+1}},et=e=>{let t=``,n=``,r=0;for(;r<e.length;){let i=e[r]||``;if(n){if(t+=i,i===`\\`){t+=e[r+1]||``,r+=2;continue}i===n&&(n=``),r+=1;continue}if(i===`/`&&e[r+1]===`*`){let t=e.indexOf(`*/`,r+2);r=t<0?e.length:t+2;continue}if(i===`"`||i===`'`){n=i,t+=i,r+=1;continue}if(i===`\\`){let n=$e(e,r);t+=n.value,r=n.nextIndex;continue}let a=i.charCodeAt(0);t+=a<32&&i!==`	`&&i!==`
`&&i!==`\r`?` `:i,r+=1}return t},tt=/^data:(?:image\/(?:avif|bmp|gif|jpeg|png|webp|x-icon)|font\/(?:collection|otf|sfnt|ttf|woff2?)|application\/(?:font-sfnt|font-woff|vnd\.ms-fontobject|x-font-opentype|x-font-ttf|x-font-woff));/i,I=e=>{let t=/^data:image\/svg\+xml(?:;charset=[A-Za-z0-9._-]+)?,([\s\S]*)$/i.exec(e);if(!t||t[1].length>1048576)return!1;let n;try{n=decodeURIComponent(t[1])}catch{return!1}if(!/^\s*<svg(?:\s|>)/i.test(n)||/<\/?(?:script|style|foreignObject|iframe|object|embed|form|link)\b/i.test(n)||/<!\s*(?:doctype|entity)\b/i.test(n)||/\son[a-z0-9_-]+\s*=/i.test(n)||/@import\b/i.test(n)||/url\s*\(\s*(?!["']?#)/i.test(n))return!1;for(let e of n.matchAll(/\s(?:href|xlink:href|src)\s*=\s*(["'])([\s\S]*?)\1/gi)){let t=rt(e[2]||``);if(!/^#[A-Za-z0-9_.:-]+$/.test(t)&&!tt.test(t))return!1}return!0},nt=e=>{let t=``;for(let n of e){let e=n.charCodeAt(0);e<=32||e>=127&&e<=159||(t+=n)}return t.trim()},rt=nt,it=/^data:(?:image\/(?:avif|bmp|gif|jpeg|png|webp|x-icon)|audio\/[a-z0-9.+-]+|video\/[a-z0-9.+-]+|text\/vtt)(?:;[^,]*)?,/i,at=e=>{let t=nt(e);return t?t.startsWith(`#`)||/^blob:/i.test(t)?!0:it.test(t):!1},L=(e,t,n={})=>{if(!e.hasAttribute(t))return;let r=nt(e.getAttribute(t)||``);(n.fragmentOnly?/^#[A-Za-z0-9_.:-]+$/.test(r):at(r))?e.setAttribute(t,r):e.removeAttribute(t)},ot=e=>{let t=e.trim(),n=t[0];return(n===`"`||n===`'`)&&t[t.length-1]===n&&(t=t.slice(1,-1).trim()),nt(t)},st=e=>{let t=ot(e);return t?t.startsWith(`#`)||/^blob:/i.test(t)?!0:tt.test(t)||I(t):!1},ct=(e,t)=>{let n=``;for(let r=t;r<e.length;r+=1){let t=e[r]||``;if(n){t===`\\`?r+=1:t===n&&(n=``);continue}if(t===`"`||t===`'`)n=t;else if(t===`)`)return r}return-1},lt=e=>{let t=!1,n=!1,r=``,i=0;for(;i<e.length;){let a=e[i]||``;if(r){if(a===`\\`){i+=2;continue}a===r&&(r=``),i+=1;continue}if(a===`/`&&e[i+1]===`*`){let t=e.indexOf(`*/`,i+2);i=t<0?e.length:t+2;continue}if(a===`"`||a===`'`){r=a,i+=1;continue}if(a===`\\`){i+=2;continue}if(a===`@`&&e.slice(i+1,i+7).toLowerCase()===`import`){let n=e[i+7]||``;(!n||!Qe(n))&&(t=!0)}if(e.slice(i,i+3).toLowerCase()===`url`&&!Qe(e[i-1]||``)){let t=i+3;for(;/\s/.test(e[t]||``);)t+=1;e[t]===`(`&&(n=!0)}i+=1}return{hasImport:t,hasUrl:n}},R=e=>{let t=lt(et(e)),n=lt(e);if(t.hasImport||t.hasUrl&&!n.hasUrl)return``;if(!n.hasUrl)return e;let r=``,i=``,a=0;for(;a<e.length;){let t=e[a]||``;if(i){if(r+=t,t===`\\`){r+=e[a+1]||``,a+=2;continue}t===i&&(i=``),a+=1;continue}if(t===`"`||t===`'`){i=t,r+=t,a+=1;continue}if(t===`/`&&e[a+1]===`*`){let t=e.indexOf(`*/`,a+2);if(t<0){r+=e.slice(a);break}r+=e.slice(a,t+2),a=t+2;continue}if(t===`\\`){r+=t,r+=e[a+1]||``,a+=2;continue}if(e.slice(a,a+3).toLowerCase()===`url`&&!Qe(e[a-1]||``)){let t=a+3;for(;/\s/.test(e[t]||``);)t+=1;if(e[t]===`(`){let n=ct(e,t+1);if(n<0)return``;let i=e.slice(t+1,n);r+=st(i)?e.slice(a,n+1):`none`,a=n+1;continue}}r+=t,a+=1}return r},ut=e=>{let t=e.defaultView;if(!t)return null;let n=Ye(t);return n.isSupported?(n.addHook(`afterSanitizeElements`,e=>{let t=e;if(t.localName?.toLowerCase()!==`style`)return;let n=R(t.textContent||``);n?t.textContent=n:t.remove()}),n.addHook(`afterSanitizeAttributes`,e=>{let t=e,n=t.localName?.toLowerCase();if(n===`a`&&(t.getAttribute(`target`)||``).trim().toLowerCase()===`_blank`&&t.setAttribute(`rel`,`noopener noreferrer`),(n===`a`||n===`area`)&&t.removeAttribute(`ping`),t.hasAttribute(`srcset`)&&t.removeAttribute(`srcset`),[`img`,`audio`,`video`,`source`,`track`,`input`].includes(n||``)&&L(t,`src`),n===`video`&&L(t,`poster`),t.hasAttribute(`background`)&&L(t,`background`),t.namespaceURI===`http://www.w3.org/2000/svg`&&n!==`a`){let e=n===`use`||n===`mpath`;L(t,`href`,{fragmentOnly:e}),L(t,`xlink:href`,{fragmentOnly:e})}if(t.hasAttribute(`style`)){let e=R(t.getAttribute(`style`)||``);e?t.setAttribute(`style`,e):t.removeAttribute(`style`)}}),n):null},z=[`<meta charset="utf-8" />`,`<meta name="viewport" content="width=device-width,initial-scale=1" />`].join(`
  `),dt=(e,t)=>{let n=F(t),r=n?ut(n):null;return r?`<!doctype html>\n${String(r.sanitize(e,Ze)).replace(`<head>`,`<head>\n  ${z}`)}`:`<!doctype html>
<html lang="en"><head><meta charset="utf-8" /></head><body></body></html>`},B=e=>{let t=e.createElement(`html`);t.lang=`en`;let n=e.createElement(`head`),r=e.createElement(`meta`);return r.setAttribute(`charset`,`utf-8`),n.append(r),t.append(n,e.createElement(`body`)),t},V=e=>{let t=e.querySelector(`:scope > head`);if(!t)return e;if(!t.querySelector(`meta[charset]`)){let n=e.ownerDocument.createElement(`meta`);n.setAttribute(`charset`,`utf-8`),t.prepend(n)}if(!t.querySelector(`meta[name="viewport"]`)){let n=e.ownerDocument.createElement(`meta`);n.setAttribute(`name`,`viewport`),n.setAttribute(`content`,`width=device-width,initial-scale=1`),t.querySelector(`meta[charset]`)?.after(n)}return e},ft=(e,t)=>{let n=F(t);if(!n)throw Error(`A browser document is required to build printable DOM.`);let r=ut(n);if(!r)return B(n);let i=r.sanitize(e,{...Ze,RETURN_DOM:!0});return!i||i.nodeType!==1||i.localName.toLowerCase()!==`html`?B(n):V(i)},H=`
  * { box-sizing: border-box; }
  html, body { margin: 0; min-height: 100%; background: #f2f4f7; color: #172033; font-family: Aptos, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; print-color-adjust: exact; -webkit-print-color-adjust: exact; }
  body { padding: 24px; }
  .viewer-export-shell { position: relative; min-height: calc(100vh - 48px); overflow: visible; background: #f2f4f7; }
  .viewer-export-content { position: relative; z-index: 1; contain: none; width: 100%; min-height: 100%; overflow: visible; }
  .viewer-export-watermark { position: absolute; inset: 0; pointer-events: none; z-index: 20; background-repeat: repeat; print-color-adjust: exact; -webkit-print-color-adjust: exact; }
  .viewer-export-content .file-render,
  .viewer-export-content .file-viewer,
  .viewer-export-content .viewer-stage,
  .viewer-export-content .content,
  .viewer-export-content .pdf-shell,
  .viewer-export-content .pdf-content,
  .viewer-export-content .pdf-viewport,
  .viewer-export-content .pdf-wrapper,
  .viewer-export-content .docx-fit-viewer,
  .viewer-export-content .docx-wrapper,
  .viewer-export-content .msdoc-stage,
  .viewer-export-content .code-viewer,
  .viewer-export-content .markdown-viewer,
  .viewer-export-content .email-shell,
  .viewer-export-content .archive-shell,
  .viewer-export-content .eda-shell,
  .viewer-export-content .ebook-shell,
  .viewer-export-content .umd-shell,
  .viewer-export-content .drawing-shell,
  .viewer-export-content .audio-shell,
  .viewer-export-content .cad-shell,
  .viewer-export-content .cad-body,
  .viewer-export-content .cad-canvas-wrap,
  .viewer-export-content .dwg-preview-frame {
    position: relative !important;
    inset: auto !important;
    contain: none !important;
    width: 100% !important;
    height: auto !important;
    min-height: 0 !important;
    max-height: none !important;
    overflow: visible !important;
  }
  .viewer-export-content .docx-wrapper {
    display: block !important;
    padding: 0 !important;
    background: transparent !important;
  }
  .viewer-export-content .docx-print-document {
    display: block !important;
    width: fit-content !important;
    max-width: 100% !important;
    height: auto !important;
    overflow: visible !important;
    margin: 0 auto !important;
  }
  .viewer-export-content .docx-page-frame {
    position: relative !important;
    width: var(--viewer-print-page-width, fit-content) !important;
    height: var(--viewer-print-page-height, auto) !important;
    min-height: var(--viewer-print-page-height, 0) !important;
    max-width: 100% !important;
    margin: 0 auto 18px !important;
    overflow: hidden !important;
    break-inside: avoid;
    page-break-inside: avoid;
    break-after: page;
    page-break-after: always;
  }
  .viewer-export-content .msdoc-page {
    position: relative !important;
    width: var(--viewer-print-page-width, 794px) !important;
    min-height: var(--viewer-print-page-height, 1123px) !important;
    max-width: 100% !important;
    height: auto !important;
    margin: 0 auto 18px !important;
    overflow: visible !important;
    break-after: page;
    page-break-after: always;
  }
  .viewer-export-content .docx-page-frame:last-child,
  .viewer-export-content .msdoc-page:last-child {
    break-after: auto;
    page-break-after: auto;
  }
  .viewer-export-content .docx-page-frame > section.docx {
    position: relative !important;
    top: auto !important;
    left: auto !important;
    width: var(--viewer-print-page-width, auto) !important;
    min-height: var(--viewer-print-page-height, auto) !important;
    max-width: none !important;
    margin: 0 auto !important;
    overflow: visible !important;
    transform: none !important;
    box-shadow: none !important;
    break-inside: avoid;
    page-break-inside: avoid;
  }
  .viewer-export-content .msdoc-stage {
    display: block !important;
    padding: 0 !important;
    background: transparent !important;
  }
  .viewer-export-content .msdoc-page > .msdoc-root {
    margin: 0 auto !important;
    box-shadow: none !important;
    overflow: visible !important;
  }
  .viewer-export-content .pdf-toolbar,
  .viewer-export-content .pdf-nav-pane,
  .viewer-export-content .viewer-actions,
  .viewer-export-content .code-toolbar,
  .viewer-export-content .umd-toolbar,
  .viewer-export-content .drawing-toolbar,
  .viewer-export-content .cad-toolbar {
    display: none !important;
  }
  .viewer-export-content .pdf-content,
  .viewer-export-content .pdf-shell--nav-hidden .pdf-content,
  .viewer-export-content .cad-body.without-layers {
    display: block !important;
    grid-template-columns: none !important;
  }
  .viewer-export-content .pdfViewer { padding: 0 !important; }
  .viewer-export-content .pdfViewer .page {
    margin: 0 auto 16px !important;
    border: 0 !important;
    box-shadow: none !important;
    break-after: page;
    page-break-after: always;
  }
  .viewer-export-content .pdfViewer .page:last-child {
    break-after: auto;
    page-break-after: auto;
  }
  .viewer-export-content .pdf-export-document {
    display: grid;
    justify-items: center;
    gap: 18px;
    padding: 4px 0;
  }
  .viewer-export-content .pdf-export-page {
    width: var(--viewer-print-page-width, auto);
    height: var(--viewer-print-page-height, auto);
    max-width: 100%;
    overflow: hidden;
    background: #ffffff;
    box-shadow: 0 12px 32px rgba(15, 23, 42, 0.12);
    break-inside: avoid;
    page-break-inside: avoid;
    break-after: page;
    page-break-after: always;
  }
  .viewer-export-content .pdf-export-page:last-child {
    break-after: auto;
    page-break-after: auto;
  }
  .viewer-export-content .pdf-export-page img {
    display: block;
    width: 100%;
    height: 100%;
    object-fit: contain;
  }
  .viewer-export-content .pptx-wrapper {
    width: 100% !important;
    max-width: 100% !important;
    height: auto !important;
    overflow: visible !important;
    transform: none !important;
  }
  .viewer-export-content .pptx-wrapper .slide {
    margin: 0 auto 18px !important;
    break-inside: avoid;
    page-break-inside: avoid;
    break-after: page;
    page-break-after: always;
    box-shadow: none !important;
  }
  .viewer-export-content .pptx-wrapper .slide:last-child {
    break-after: auto;
    page-break-after: auto;
  }
  .viewer-export-content .ofd-stage {
    padding: 0 !important;
    overflow: visible !important;
  }
  .viewer-export-content .ofd-page,
  .viewer-export-content .drawing-svg,
  .viewer-export-content .cad-canvas-wrap,
  .viewer-export-content .dwg-preview-frame {
    break-inside: avoid;
    page-break-inside: avoid;
    break-after: page;
    page-break-after: always;
    box-shadow: none !important;
  }
  .viewer-export-content .ofd-page:last-child,
  .viewer-export-content .drawing-svg:last-child,
  .viewer-export-content .cad-canvas-wrap:last-child,
  .viewer-export-content .dwg-preview-frame:last-child {
    break-after: auto;
    page-break-after: auto;
  }
  .viewer-export-content .code-area {
    overflow: visible !important;
    white-space: pre-wrap !important;
    word-break: break-word !important;
  }
  .viewer-export-content .umd-body,
  .viewer-export-content .umd-stage-wrap,
  .viewer-export-content .umd-stage {
    display: block !important;
    height: auto !important;
    max-height: none !important;
    overflow: visible !important;
  }
  .viewer-export-content .umd-toc {
    display: none !important;
  }
  img, canvas, svg, video { max-width: 100%; }
  @media print {
    @page { margin: 12mm; }
    html, body { min-height: auto; background: #ffffff; }
    body { padding: 0; }
    .viewer-export-shell,
    .viewer-export-content {
      min-height: 0;
      overflow: visible;
      background: #ffffff;
    }
    .viewer-export-content .pdf-export-document {
      display: block;
      padding: 0;
    }
    .viewer-export-content .pdf-export-page {
      width: var(--viewer-print-page-width, auto) !important;
      height: var(--viewer-print-page-height, auto) !important;
      max-width: none !important;
      margin: 0;
      overflow: hidden;
      box-shadow: none;
    }
    .viewer-export-content .docx-page-frame {
      width: var(--viewer-print-page-width, auto) !important;
      height: var(--viewer-print-page-height, auto) !important;
      min-height: var(--viewer-print-page-height, 0) !important;
      max-width: none !important;
      margin: 0 !important;
      overflow: hidden !important;
    }
    .viewer-export-content .msdoc-page {
      width: var(--viewer-print-page-width, 794px) !important;
      min-height: var(--viewer-print-page-height, 1123px) !important;
      max-width: none !important;
      margin: 0 !important;
      overflow: visible !important;
    }
    .viewer-export-content .docx-page-frame > section.docx,
    .viewer-export-content .msdoc-page > .msdoc-root {
      width: var(--viewer-print-page-width, 100%) !important;
      max-width: none !important;
      border: 0 !important;
    }
    .viewer-export-content .pptx-wrapper .slide,
    .viewer-export-content .ofd-page,
    .viewer-export-content .drawing-svg,
    .viewer-export-content .cad-canvas-wrap,
    .viewer-export-content .dwg-preview-frame {
      box-shadow: none !important;
    }
  }
`,pt=e=>{let t=F(e);return t?Array.from(t.querySelectorAll(`style, link[rel="stylesheet"]`)).map(e=>{if(e.localName.toLowerCase()===`style`)return`<style>${e.textContent||``}</style>`;let t=e;try{let e=Array.from(t.sheet?.cssRules||[]).map(e=>e.cssText).join(`
`);return e?`<style data-viewer-inlined-stylesheet>${e}</style>`:``}catch{return``}}).filter(Boolean).join(`
`):``},mt=({contentHtml:e,includeDocumentStyles:t=!0,printStyle:n=``,title:r,watermarkInlineStyle:c=``,mask:l=null,documentRef:u})=>{let d=c?`<div class="viewer-export-watermark" style="${Xe(c)}"></div>`:``,f=s(l),p=f?{...f,regions:f.regions?.filter(e=>e.pageIndex===void 0),stamps:f.stamps?.filter(e=>e.pageIndex===void 0)}:null,m=o(p),ee=i(e,f),h=t?pt(u):``,g=n?`<style data-viewer-print-style>${n}</style>`:``,te=f?`<style data-viewer-print-mask-style>${a}</style>`:``;return`<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>${Xe(r)}</title>
  ${h}
  <style>${H}</style>
  ${te}
</head>
<body>
  <main class="viewer-export-shell">
    <div class="viewer-export-content">${ee}</div>
    ${m}
    ${d}
  </main>
  ${g}
</body>
</html>`},ht=e=>dt(mt(e),e.documentRef),gt=e=>ft(mt(e),e.documentRef),U=async({source:i,mode:a=`export`,title:o,adapter:c=null,watermarkInlineStyle:l=``,mask:u=null})=>{let d={mode:a,title:o},f=c?.toHtml,p=s(u);if(f){await e(i,c);let t=await n(await f(d)),a=await r(c,d);return{contentHtml:t,includeDocumentStyles:c.includeDocumentStyles!==!1,printStyle:a,title:o,watermarkInlineStyle:l,mask:p,documentRef:i.ownerDocument}}await e(i,c);let m=i.cloneNode(!0);m.querySelectorAll(`.viewer-watermark`).forEach(e=>e.remove()),t(i,m);let ee=await r(c,d);return{contentHtml:await n(m.innerHTML),printStyle:ee,title:o,watermarkInlineStyle:l,mask:p,documentRef:i.ownerDocument}},W=async e=>ht(await U(e)),G=async e=>gt(await U(e));export{G as buildFileViewerRenderedDomDocument,W as buildFileViewerRenderedHtmlDocument};