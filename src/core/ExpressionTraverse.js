let config = require('../config')
let util = require('../core/util')
let {
    prefix,
    suffix
} = config.interpolation;
const {
    transform
} = require('./transformer')
const fs = require('fs-extra');
const t = require('babel-types')
const p = require('path');
const {
    resourceDir,
    outputDir
} = config;

const ROOT_PARENT_TYPES = {
    ObjectProperty: true, // 对象属性
    ConditionalExpression: true, // 条件
    VariableDeclarator: true, // 变量初始化
    AssignmentExpression: true, // 赋值语句
    ReturnStatement: true, // 返回语句
    JSXExpressionContainer: true, // jsx表达式
    JSXAttribute: true, // jsx属性 
    ArrayExpression: true, // 数组
    CallExpression: true, // 函数调用
    AssignmentPattern: true, // 函数默认值
    LogicalExpression: true, // 逻辑表达式
    ClassProperty: true, // 类属性
    SwitchStatement: true, // switch语句
    SwitchCase: true, // switch case  
    NewExpression: true, // new Error('ff') 
    ArrowFunctionExpression: true, // value => Big(value || 0).div(100).toFixed(2) + '元'
}
const rootOperator = ['==', '!=', '===', '!==', 'in'];
const variableOperator = ['-', '*', '/'];
// 判断是否为rootPath的父亲
function isRootParentPath(path) {
    let {
        node
    } = path;
    let {
        type
    } = node;
    switch (type) {
        case 'BinaryExpression':
            if (rootOperator.includes(node.operator)) {
                return true;
            };
            break;
    }

    return !!ROOT_PARENT_TYPES[type];
}

class TraverseHistory {
    constructor() {
        this.cache = new Map();
    }
    hashCode(path) {
        let {
            loc
        } = path.node;
        if (loc == null) {
            throw new Error('empty loc')
        }
        let {
            start,
            end
        } = loc;
        return `${path.hub.file.log.filaname}:${start.line},${start.column}-${end.line},${end.column}`
    }
    add(path) {
        this.cache.set(this.hashCode(path), true);
    }
    has(path) {
        return this.cache.has(this.hashCode(path));
    }
}

function staticCaseHandler(path) {
    let node = path.node;
    switch (node.type) {
        case 'StringLiteral':
        case 'JSXText':
            return {
                template: node.value.trim()
            };
    }
    return null;
}

function variableCaseHandler(path) {
    let node = path.node;
    let variableName = config.strategy.variableStrategy({});
    let template = `${prefix}${variableName}${suffix}`;
    let param = null;
    switch (node.type) {
        case 'JSXEmptyExpression':   //空语句不管
            return {}
        break;
        case 'JSXExpressionContainer': 
            return variableCaseHandler(path.get('expression'));
        break;
        case 'LogicalExpression':
        case 'CallExpression':
        case 'MemberExpression':
        case 'ConditionalExpression':
            param = `${variableName}:${path.getSource()},`
            return {
                template,
                param
            };
            break;
        case 'BinaryExpression': //数学运算
            let {
                operator
            } = node;
            if (variableOperator.includes(operator)) {
                param = `${variableName}:${path.getSource()},`
                return {
                    template,
                    param
                }
            }
            break;
        case 'Identifier':
            param = `${variableName}:${node.name},`
            return {
                template,
                param
            }
            break;
    }
    return null;
}

function dynamicCaseHandler(path) {
    let node = path.node;
    switch (node.type) {
        case 'BinaryExpression':
            let {
                operator
            } = path.node;
            let left = path.get('left')
            let right = path.get('right')
            if (operator !== '+') {
                // +认为是字符串相加
                return null;
            }

            let leftResult = recursiveEval(left);
            let rightResult = recursiveEval(right);
            return mergeResult(leftResult, rightResult);

        case 'TemplateLiteral':
            // 模板直接正则来做
            let sourceStr = path.getSource();
            let param = [];
            //  param格式为`${variableName}:${node.name},`
            let template = sourceStr.replace(/([\s\S]*?\${)([\w\.\[\]]+?)(}[\s\S]*?)/g, (m, $1, $2, $3) => {
                    let variableName = config.strategy.variableStrategy({});
                    param.push(`${variableName}:${$2}`);
                    return `${$1}${variableName}${$3}`
                })
                .replace(/^`([\s\S]*)`$/, '$1')
            if (!util.isChinese(template)) {
                return {};
            }
            param = param.join(',')
            return {
                template,
                param
            }
    }
    return null;
}

function mergeResult(...targets) {
    let dest = {
        template: '',
        param: ''
    }
    for (let target of targets) {
        if(target.template){
            dest.template += target.template;
        }
        if (target.param) {
            dest.param += target.param;
        }
    }
    return dest;
}

function recursiveEval(path) {
    let result = null;
    // 仅是静态模板
    if (result = staticCaseHandler(path)) {
        return result;
    }
    // 仅是变量
    if (result = variableCaseHandler(path)) {
        return result;
    };
    // 动态模板 与 字符串组合而成
    if (result = dynamicCaseHandler(path)) {
        return result;
    };

    // 不能处理返回 
    throw new Error('can not resolve expression')
    // TODO 顶层不能处理返回 null 后面返回getSource()容错?
    //return {
        // template:path.getSource()
//};
}


class FileHelper {
    constructor(basePath) {
        // this.basePath = basePath.replace(/\\/g, '/');
    }
    getTransformFilePath(filePath) {
        filePath = filePath.split(/\/|\\/g).slice(-2);
        return p.resolve(outputDir, ...filePath)
    }
    getResourceFilePath(filaname) {
        return p.resolve(resourceDir, filaname)
    }
    writeResouce(filename, json) {
        let resourcePath = this.getResourceFilePath(filename);
        if(fs.existsSync(resourcePath)){
            // 如果存在则合并
            let oldJson = fs.readJsonSync(resourcePath);
            json = Object.assign(oldJson,json)
        }
        fs.outputJSONSync(resourcePath, json, {
            encoding: 'utf-8'
        });
    }
    write(filePath, content) {
        if (!config.rewrite) {
            filePath = this.getTransformFilePath(filePath)
        }
        fs.outputFileSync(filePath, content, {
            encoding: 'utf-8'
        });
    }
}
class Expression {
    constructor(path) {
        // rootPath可能是数组  JSXElment的children
        this.curRootPath = path;
        this.resourceInfo = null;
    }
    evaluatePath(path){
        let result = {};
        // 表达式由多个子path构成
        if(Array.isArray(path)){
            for(let onePath of path){
                let partialResult = recursiveEval(onePath);
                result = mergeResult(result,partialResult);
            }
        }else{
            result = recursiveEval(path)
        }
        return result;
       
    }
    evaluate() {
        // 递归得出表达式的template和param
        let expResult;
        try {
            expResult = this.evaluatePath(this.curRootPath);
        } catch (e) {
            util.warn(`${e.message}:解析表达式失败`, this.curRootPath)
            // 不能处理的场景 1+a+'s'
            return null;
        }
         let {
            template,
            param
        } = expResult;
        if (template == null) {
            // 不用处理
            return null;
        }
        template = template.replace(/\s+/g,'').replace(/(:|：)$/g,'');
        // template没有中文 {marginBottom: (4 - addressLength) * 60 + 'px'} 
        if (!util.isChinese(template)) {
            return null;
        }
        this.replaceSource(template, param)
        return this.resourceInfo;
    }
    getPath() {
        return this.curRootPath;
    }
    replaceSource(template, param) {
        // 一个表达式一个key
        let key = config.strategy.keyStrategy({
            template
        });
        let path = this.curRootPath;
        // 记录替换之前node的信息
        // let oldLoc = path.node.loc;
        this.resourceInfo = {
            [key]: {
                ...util.getMetaFromPath(path),
                template,
            }
        };

        let comment = util.makeComment(config.strategy.commentStrategy({
            template,
            sourceStr:util.getSource(path)
        }));
        let sourceStr = `${config.callStatement}('${key}')${comment}`;
        if (param) {
            sourceStr = `${config.callStatement}('${key}',{${param}})${comment}`;
        }

        try {
            let {
                expression
            } = util.parseStr(sourceStr);
            // 特殊情况处理 []
            // jsx 
            if(Array.isArray(path)){
                let parentPath = path[0].parentPath;
                if(t.isJSXElement(parentPath)){
                    parentPath.node.children = [t.JSXExpressionContainer(expression)];
                }else{
                    util.throwError('不能解析的数组path',parentPath)
                }
            }
            else if (t.isJSXText(path.node)   // 单独解析的JSXText
                || t.isJSXAttribute(path.parent)) {
                path.replaceWith(
                    t.JSXExpressionContainer(expression)
                );
            } else if (t.isObjectProperty(path.parent)
                && path.parentKey === 'key') { //对象属性的key { [‘中国’] }
                path.parentPath.node.computed = true;
                path.replaceWith(expression)
            } else {
                path.replaceWith(expression)
            }
            // path.node.loc = oldLoc; // 修复loc 用于hash防止多次遍历节点
        } catch (err) {
            util.throwError(`表达式替换出错:${err.message}\n${sourceStr}`, path)
        }
    }

}

class ExpressionTraverse {
    constructor() {
        this.history = new TraverseHistory();
        this.store = {};
        this.resource = null;
    }
    start(files) {
        const transformPlugin = require('../plugin');
        let fileHelper = new FileHelper();
        files.forEach((filePath) => {
            const code = transform(filePath, transformPlugin)
            // 文件更新替换为 i18n.get 
            fileHelper.write(filePath, code);
        });
        // 资源文件
        fileHelper.writeResouce('source.json', this.sourceInfo)
        fileHelper.writeResouce('ZH-CN.json', this.langResource)
    }
    findRoot(path) {
        // 子能找到父 父找不到子(可能一对多)
        let rootPath = null;
        let curPath = path;
        while (path = path.parentPath) {
            if (isRootParentPath(path)) {
                rootPath = curPath;
                break;
            }
            curPath = path;
        }

        return rootPath;
    }
    traverse(path) {
        // root 代表 expression的起点
        // jsx无法判断明确的起点
        let rootPath = this.findRoot(path);
        util.assert(rootPath == null, '找不到root的场景', path)
        // root为ArrayExpression 此时有多个 elements
        // 不一定扁平 ['we',{d:'ewe'}] 因此要单独对每一个child 处理
        this.traverseByRoot(rootPath);
    }
    traverseJSXText(textPath){
        let jsxElement = textPath.find((p)=>t.isJSXElement(p));
        let childrenPaths = jsxElement.get('children');
        let hasChildElement = childrenPaths.some((child)=>t.isJSXElement(child));
        if (!hasChildElement) {
            // 中文 + variable 的情况
            let hasChinese = childrenPaths.some((child)=>t.isJSXText(child) && util.isChinese(child.node.value));
            let hasVariable = childrenPaths.some((child)=>t.isJSXExpressionContainer(child));

            if(hasChinese && hasVariable){
                // 多个path
                return this.buildExpression(childrenPaths);
            }
        }
        // 默认单独处理JSXText
        return this.traverseByRoot(textPath);
    }
    buildExpression(rootPath){
        let exp = new Expression(rootPath)
        let result = exp.evaluate();
        if (result == null) {
            // 计算不了的情况 ['e',{a:{f:'d'},}] if(a=='c')
            return;
        }

        Object.assign(this.store, result);
    }
    traverseByRoot(rootPath) {
        util.log(`开始遍历节点`, rootPath)
        // 已经替换过的path
        // if (this.history.has(rootPath)) {
        //     return;
        // }
        // 仅由StringLiteral/JSXText 且不是中文 构成的expression
        if (staticCaseHandler(rootPath) &&
            !util.isChinese(rootPath.node.value)) {
            return;
        }
        if (util.hasTransformedPath(rootPath)) {
            // 已经是 i18n 函数
            util.warn(`重复遍历的rootPath$`, rootPath)
            return;
        }
        // 是moment
        if (util.isMomentFormat(rootPath)) {
            return;
        }
        
        this.buildExpression(rootPath)
        // 新生成的节点不用遍历 rootPath.skip(); 之后还是会遍历
        // this.history.add(exp.getPath());
    }

    get keyLen(){
        return Object.keys(this.store).length;
    }
    get langResource() {
        if(this.resource == null){
            this.resource = Object.entries(this.store).reduce((accm,[key,o])=>{
                accm[key] = o.template;
                return accm;
            },{})
        }
        return this.resource;
    }
    get sourceInfo() {
        return this.store;
    }

}
module.exports = new ExpressionTraverse();