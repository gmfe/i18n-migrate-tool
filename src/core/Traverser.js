let util = require('../util')
let config = require('../config')
const fileHelper = require('./fileHelper');
const t = require('babel-types')
const initTransformer = require('../plugin/transformer')
const transformPlugin = require('../plugin/transformPlugin')
const syncPlugin = require('../plugin/syncPlugin')
const {
    KeyStrategy,
    CommentStrategy
} = require('./strategy')
const Expression = require('./Expression')
const EXCLUDE_TYPE = {
    ImportDeclaration: true, // import语句中的字符串
    MemberExpression: true, // 类似user['name']
}

function shouldExclude(path) {
    let type = path.parent.type
    switch (type) {
        case 'NewExpression':
            if (path.parent.callee.name === 'RegExp') { // 正则跳过
                return true;
            }
            break;
    }
    return !!EXCLUDE_TYPE[type];
}
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

function isRootParentPath(path) {
    let {
        node
    } = path;
    switch (node.type) {
        case 'BinaryExpression':
            if (rootOperator.includes(node.operator)) {
                return true;
            };
            break;
    }

    return !!ROOT_PARENT_TYPES[node.type];
}

class Traverser {
    constructor() {
        this.sourcemap = {};
        this.extraKeys = {};
        this.setup();
    }
    setup() {
        let initial = 1;
        let sourcemap = fileHelper.getSourceMapContent();
        if (sourcemap) {
            initial = sourcemap.meta.nextKeyNum;
        }
        this.ctx = {
            keyStrategy: new KeyStrategy(initial),
            commentStrategy: new CommentStrategy(),
        }
    }
    syncResource(files){
        const {
            transformFile
        } = initTransformer([syncPlugin(this)]);

        files.forEach((filePath) => {
            transformFile(filePath)
        });
        let sourcemap = fileHelper.getSourceMapContent();
        if(!sourcemap){
            return;
        }
        
        let sourceData = sourcemap.data;
        // 不能直接覆盖 因为拿不到模板
        // 删除多余的
        Object.keys(sourceData).forEach((key)=>{
            if(!this.extraKeys.hasOwnProperty(key)){
                delete sourceData[key];
            }
        })
         // 添加新的 需要手动去写模板
         Object.keys(this.extraKeys).forEach((key)=>{
            if(!sourceData.hasOwnProperty(key)){
                sourceData[key] = this.extraKeys[key];
            }
        })
        this.writeLang(sourceData);
        fileHelper.writeSourceMap(sourcemap);
    }
    addKey(path,key){
        // 默认key作template
        this.extraKeys[key] = util.getKeyInfo(path,key);
    }
    traverseFiles(files) {
        const {
            transformFile
        } = initTransformer([transformPlugin(this)]);

        files.forEach((filePath) => {
            // 替换\t
            fileHelper.formatTabs(filePath)
            const code = transformFile(filePath)
            // 替换为 i18n.t 
            fileHelper.write(filePath, code);
        });
        this.writeResourceByMerge();
    }
    buildExpression(rootPath) {
        let exp = new Expression(rootPath, this.ctx)
        let result = exp.evaluateAndReplace();
        if (result == null) {
            // 计算不了或跳过的情况 
            return false;
        }

        Object.assign(this.sourcemap, result);
        return true;
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
    traverseNodePath(path) {
        // path 只可能为 String Template
        // 已经是I8N
        if (util.hasTransformedString(path)) {
            return;
        }
        // 特殊的语句
        if (shouldExclude(path)) {
            return;
        }
        // root 代表 expression的起点
        let rootPath = this.findRoot(path);
        if(rootPath == null){
            util.warn('找不到root的场景', path)
            return;
        }
        this.traverseRootPath(rootPath);
    }
    traverseJSXText(textPath) {
         if (!config.fixjsx) {
            // 默认独立解析
            return this.traverseRootPath(textPath);
         }

        let jsxElement = textPath.find((p) => t.isJSXElement(p));
        let childrenPaths = jsxElement.get('children');
        let hasChildElement = childrenPaths.some((child) => t.isJSXElement(child));
        if (!hasChildElement) {
            // 中文 + variable 的情况
            let hasChinese = childrenPaths.some((child) => t.isJSXText(child) && util.isChinese(child.node.value));
            let hasVariable = childrenPaths.some((child) => t.isJSXExpressionContainer(child));

            if (hasChinese && hasVariable) {
                // 多个path
                let isSuccess = this.buildExpression(childrenPaths);
                if (!isSuccess) {
                    // 回退
                    util.log('尝试整体解析JSXText失败，开始单独解析\n');
                    return this.traverseRootPath(textPath);;
                }
                return;
            }
        }
        // 单独处理JSXText
        return this.traverseRootPath(textPath);
    }
    traverseRootPath(rootPath) {
        util.debug(`开始遍历rootPath：`, rootPath)
        // 仅由StringLiteral/JSXText 且不是中文 构成的expression
        if ((t.isStringLiteral(rootPath) || t.isJSXText(rootPath)) &&
            !util.isChinese(rootPath.node.value)) {
            return;
        }
        if (util.hasTransformedString(rootPath)) {
            // 已经是 i18n 函数
            util.warn(`重复遍历的rootPath：`, rootPath)
            return;
        }
        // 是moment
        if (util.isMomentFormat(rootPath)) {
            return;
        }

        this.buildExpression(rootPath)
    }
    writeLang(sourcemap){
        let langResource = Object.entries(sourcemap)
        .reduce((accm, [key, o]) => {
            accm[key] = o.template;
            return accm;
        }, {})
        // 多语资源文件
        fileHelper.writeLang(langResource)
    }
    writeResourceByMerge() {
        let oldSourcemap = fileHelper.getSourceMapContent();
        let toWriteSouceMap = this.sourcemap;
        if(oldSourcemap){
            toWriteSouceMap = Object.assign(oldSourcemap.data,this.sourcemap)
        }

        this.writeLang(toWriteSouceMap);
        let nextKeyNum = this.ctx.keyStrategy.count;
        toWriteSouceMap= {
            data: toWriteSouceMap,
            meta: {
                nextKeyNum
            }
        }
        // 映射文件
        fileHelper.writeSourceMap(toWriteSouceMap)
    }
    get keyLen() {
        let keys = this.sourcemap || this.extraKeys
        return Object.keys(keys).length;
    }
}
module.exports = Traverser;