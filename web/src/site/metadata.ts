const pages: Record<string, {title: string; description: string}> = {
 '/': {title:'全龄终身学习平台',description:'从启蒙、学校、大学与职业发展，到兴趣生活和银龄学习，知阶连接知识、实践与成长。'},
 '/explore': {title:'探索终身学习',description:'探索各阶段学习方向、跨阶段领域和个人、家庭及组织支持入口；实际可学资源按授权展示。'},
 '/features': {title:'产品功能',description:'了解知阶的组织班级、课程学习、实践作业与评估功能。'},
 '/ai-teaching': {title:'AI 教学',description:'了解有来源的学习答疑、教师备课、题目与任务报告建议，以及人工审核边界。'},
 '/solutions': {title:'学习场景',description:'了解从启蒙到银龄的终身学习场景，以及个人、家庭、学校、机构与社区的支持方式。'},
 '/help': {title:'使用帮助',description:'了解管理员开通账号、选择组织、学习课程和开展培训的操作步骤。'},
 '/about': {title:'关于知阶',description:'知阶 KnowLadder 尊重教师判断，依据真实记录支持持续学习。'},
 '/contact': {title:'联系咨询',description:'了解培训系统咨询与回执查询；咨询开放以组织配置和信息用途同意为前提。'},
};
function meta(name: string, content: string, property = false) {
 const attribute = property ? 'property' : 'name';
 let element = document.head.querySelector<HTMLMetaElement>('meta['+attribute+'="'+name+'"]');
 if (!element) {element = document.createElement('meta');element.setAttribute(attribute,name);document.head.append(element);}
 element.content = content;
}
export function updateSiteMetadata(path: string) {
 const page = pages[path];
 meta('robots',page ? 'index,follow' : 'noindex,nofollow');
 meta('description',page?.description ?? '知阶工作区：需要账号与当前组织授权。');
 for(const key of ['og:title','og:description','og:url','og:type'])document.head.querySelector('meta[property="'+key+'"]')?.remove();
 document.head.querySelector('link[rel="canonical"]')?.remove();
 if (!page) return;
 const canonical = new URL(path,window.location.origin).href;
 const link = document.createElement('link');link.rel='canonical';link.href=canonical;document.head.append(link);
 meta('og:title',page.title+' | 知阶 KnowLadder',true);meta('og:description',page.description,true);meta('og:url',canonical,true);meta('og:type','website',true);
}
