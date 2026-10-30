// Progress ledger: source inventory is not acceptance evidence.
import ts from 'typescript';
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
const read=p=>readFileSync(p,'utf8');
const hash=p=>existsSync(p)?createHash('sha256').update(readFileSync(p)).digest('hex'):null;
const parse=p=>ts.createSourceFile(p,read(p),ts.ScriptTarget.Latest,true);
const walk=(node,fn)=>{fn(node);ts.forEachChild(node,n=>walk(n,fn));};
const router=parse('src/router.ts');
const routes=[];
walk(router,node=>{
 if(!ts.isCallExpression(node)||node.expression.getText(router)!=='commandGroup.use')return;
 const object=node.arguments[0];if(!ts.isObjectLiteralExpression(object))return;
 const path=object.properties.find(p=>p.name?.getText(router)==='path');
 let names=[];
 if(ts.isPropertyAssignment(path)&&ts.isStringLiteral(path.initializer))names=[path.initializer.text];
 else if(ts.isShorthandPropertyAssignment(path)){
  let parent=node.parent;
  while(parent&&!ts.isForOfStatement(parent))parent=parent.parent;
  if(parent&&ts.isArrayLiteralExpression(parent.expression))names=parent.expression.elements.filter(ts.isStringLiteral).map(n=>n.text);
 }
 let handler='';walk(node.arguments[1],child=>{if(ts.isStringLiteral(child)&&child.text.startsWith('@src/response/'))handler=child.text.replace('@src/','src/')+'.ts';});
 const eventProp=object.properties.find(p=>p.name?.getText(router)==='events');
 for(const name of names)routes.push({command:'/'+name,handler,events:eventProp?.initializer?.getText(router)||'群聊与私聊',entry:'commandGroup'});
});
for(const [command,handler] of [['个人登录','personal-login'],['个人退出','personal-login'],['添加钥匙','key-intake']])routes.push({command:'/'+command,handler:`src/response/${handler}/res.ts`,events:'前置事件处理器，权限由处理函数判断',entry:'event'});
const evidence=JSON.parse(read('docs/bubble-review.json')).files;
const handlers=[...new Set(routes.map(r=>r.handler))].sort().map(file=>{
 const ast=parse(file),points=[],variants=[];
 walk(ast,node=>{
  if(ts.isBinaryExpression(node)&&node.operatorToken.kind===ts.SyntaxKind.EqualsToken&&node.left.getText(ast)==='text')variants.push({line:ast.getLineAndCharacterOfPosition(node.getStart(ast)).line+1,preview:node.right.getText(ast).slice(0,300),acceptance:'未逐点验收'});
  if(!ts.isCallExpression(node))return;
  const name=node.expression.getText(ast);
  if(!['reply','commandBubble','noticeBubble','sectionBubble','detailBubbles'].includes(name))return;
  let parent=node.parent,shared=false;const conditions=[];
  while(parent){
   if(ts.isVariableDeclaration(parent)&&['reply','send'].includes(parent.name.getText(ast)))shared=true;
   if(ts.isIfStatement(parent))conditions.push(parent.expression.getText(ast).slice(0,200));
   parent=parent.parent;
  }
  if(shared)return;
  points.push({line:ast.getLineAndCharacterOfPosition(node.getStart(ast)).line+1,kind:name,preview:node.arguments[0]?.getText(ast).slice(0,240)||'',conditions,acceptance:'未逐点验收'});
 });
 const e=evidence[file];
 const status=!e?'未登记验证':hash(file)===e.sourceHash&&Object.entries(e.tests||{}).every(([p,h])=>hash(p)===h)?'局部证据有效':'有改动，需复核证据';
 return {file,commands:routes.filter(r=>r.handler===file).map(r=>r.command),status,points,textVariants:variants,covered:e?.covered||[],pending:e?.pending||['需逐分支梳理与运行验证'],tests:Object.keys(e?.tests||{})};
});
const totals={registeredPaths:routes.filter(r=>r.entry==='commandGroup').length,eventCommands:3,allCommandEntries:routes.length,rootCommands:new Set(routes.map(r=>r.command.split(' ')[0])).size,handlerGroups:handlers.length,replyPoints:handlers.reduce((s,h)=>s+h.points.length,0),textAssignmentVariants:handlers.reduce((s,h)=>s+h.textVariants.length,0),currentPartial:handlers.filter(h=>h.status==='局部证据有效').length,stalePartial:handlers.filter(h=>h.status==='有改动，需复核证据').length,noEvidence:handlers.filter(h=>h.status==='未登记验证').length,fullyAccepted:0};
const sourceInventory=JSON.parse(read('docs/bubble-audit.json'));
totals.allSourceSites=sourceInventory.sites.length;
totals.allSourceFiles=new Set(sourceInventory.sites.map(s=>s.file)).size;
const scenarioLedger=existsSync('docs/bubble-scenarios.json')?JSON.parse(read('docs/bubble-scenarios.json')).scenarios:[];
totals.scenariosRegistered=scenarioLedger.length;
totals.scenariosAutoVerified=scenarioLedger.filter(s=>s.status==='automated-pass'&&hash(s.handler)===s.sourceHash&&hash(s.test)===s.testHash).length;
totals.scenariosPending=scenarioLedger.filter(s=>s.status==='pending').length;
totals.scenariosClientVerified=scenarioLedger.filter(s=>s.clientVerified).length;
const labels={scenariosRegistered:'已单独登记场景（尚未穷尽）',scenariosAutoVerified:'场景自动化验证通过且证据有效',scenariosPending:'已登记但待验证场景',scenariosClientVerified:'场景实机验收通过',registeredPaths:'普通路由登记数',eventCommands:'前置处理器指令数',allCommandEntries:'指令入口总数（含别名与子路径）',rootCommands:'顶层指令名数（含别名）',handlerGroups:'处理组数',replyPoints:'指令组静态回复点（非逻辑场景数）',textAssignmentVariants:'另有文本赋值分支（可能共用发送点）',currentPartial:'局部证据仍匹配的组',stalePartial:'证据需复核的组',noEvidence:'尚未登记证据的组',fullyAccepted:'整组验收完成数',allSourceSites:'全 src 候选发送/渲染调用点',allSourceFiles:'涉及源码文件数'};
const data={note:'回复点是去除 reply/send 包装器后的静态调用位置，附条件仅作分支定位；不是最终逻辑场景数。一点可因身份/平台/内容产生多种气泡，长内容还会分条。另列 text 赋值分支，避免钥匙等处理函数共用一个发送点却产生多类气泡被漏记；这些也不直接相加为场景数。未逐点验收前不计算完成百分比。完整范围另含普通聊天、主动投递、媒体与共享输出（见 bubble-audit.json）。',totals,handlers};
writeFileSync('docs/bubble-progress.json',JSON.stringify(data,null,2)+'\n');
const rows=handlers.map(h=>`| ${h.commands.map(c=>'`'+c+'`').join('、')} | ${h.points.length} | ${h.textVariants.length} | ${h.status} | ${h.covered.length} | ${h.pending.length} |`).join('\n');
const md=`# 气泡整理总账与执行计划\n\n此文件由 \`node scripts/bubble-progress.mjs\` 生成。逐条位置、原文预览和条件见 [bubble-progress.json](bubble-progress.json)，历史证据见 [bubble-review.json](bubble-review.json)。\n\n## 当前统计\n\n${Object.entries(totals).map(([k,v])=>'- '+labels[k]+': '+v).join('\n')}\n\n统计边界：${data.note}\n\n## 指令分组\n\n| 指令入口（含别名） | 静态回复点 | 共用发送的文本分支 | 验证状态 | 已登记验证项 | 明确待验证项 |\n| --- | ---: | ---: | --- | ---: | ---: |\n${rows}\n\n## 逐场景账\n\n见 [bubble-scenarios.json](bubble-scenarios.json)：每个场景有稳定编号、范围说明、当前状态、源码与测试哈希及实机状态。当前登记范围尚未穷尽，不用局部场景数计算全量完成率。\n\n## 后续执行与验收\n\n1. 补全分支场景账：按 JSON 中每个回复点展开成功、空状态、错误输入、权限拒绝、异常和长内容；记录平台、身份、作用范围、按钮及跳转。静态回复点不直接等于场景。\n2. 优先复核证据漂移，再补未登记组。每个修复同步登记具体场景、测试和仍未验证的内容。\n3. 对修改、删除、额度与钥匙边界执行隔离存储/真实路由验证；对普通聊天、后台投递、媒体和共享渲染使用全 src 清单补充覆盖。\n4. 源码与运行测试完成后核对实际 QQ/OneBot 展示；每个场景证明内容可读、权限/范围真实、动作可达、分页完整、无 bar，再逐点验收。\n\n目前整组验收完成为 0，并非没有完成工作，而是旧账只有文件级局部证据，尚不能证明任一组所有分支均完成。没有可信分母前不报百分比。\n`;
writeFileSync('docs/BUBBLE_PROGRESS.md',md);
console.log(JSON.stringify(totals));
