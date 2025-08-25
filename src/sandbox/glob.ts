function esc(s: string){return s.replace(/[-/\\^$+?.()|[\]{}]/g,"\\$&");}
export function globToRegExp(glob: string): RegExp{
  glob = glob.replace(/^[.][/\\]/,"");
  let re="^";
  for(let i=0;i<glob.length;){
    const c=glob[i]!;
    if(c==="*"){
      if(glob[i+1]==="*"){re+=".*"; i+=2;} else {re+="[^/]*"; i++;}
    }else if(c==="?"){re+="[^/]"; i++;}
    else if(c==="/"||c==="\\"){re+="/"; i++;}
    else{re+=esc(c); i++;}
  }
  return new RegExp(re+"$");
}
export function matchAny(globs:string[], p:string){
  const path = p.replace(/^[.][/\\]/,"").replace(/\\/g,"/");
  return globs.some(g=>globToRegExp(g).test(path));
}
