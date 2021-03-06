import * as vscode from 'vscode'
import * as fs from 'fs'
import * as path from 'path'

import { Extension } from '../main'

/**
 * Finding the longest substring containing balanced {...}
 * @param s a string
 */
function getLongestBalancedString(s: string) : string {
    let nested = 1
    let i = 0
    for (i = 0; i < s.length; i++) {
        switch (s[i]) {
            case '{':
                nested++
                break
            case '}':
                nested --
                break
            default:
        }
        if (nested === 0) {
            break
        }
    }
    return s.substring(0, i)
}

export class SectionNodeProvider implements vscode.TreeDataProvider<Section> {

    private _onDidChangeTreeData: vscode.EventEmitter<Section | undefined> = new vscode.EventEmitter<Section | undefined>()
    readonly onDidChangeTreeData: vscode.Event<Section | undefined> = this._onDidChangeTreeData.event
    private hierarchy: string[]
    private sectionDepths: { string?: number } = {}
    public root: string = ''

    // our data source is a set multi-rooted set of trees
    private ds: Section[] = []

    constructor(private extension: Extension) {
        const configuration = vscode.workspace.getConfiguration('latex-workshop')
        this.hierarchy = configuration.get('view.outline.sections') as string[]
        this.hierarchy.forEach((section, index) => {
            section.split('|').forEach(sec => {
                this.sectionDepths[sec] = index
            })
        })
    }

    refresh() : Section[] {
        if (this.extension.manager.rootFile) {
            this.ds = this.buildModel(this.extension.manager.rootFile)
            return this.ds
        } else {
            return []
        }
    }

    update() {
        this._onDidChangeTreeData.fire()
    }

    buildModel(filePath: string, parentStack?: Section[], parentChildren?: Section[], imports: boolean = true) : Section[] {

        let rootStack: Section[] = []
        if (parentStack) {
            rootStack = parentStack
        }

        let children: Section[] = []
        if (parentChildren) {
            children = parentChildren
        }

        let prevSection: Section | undefined = undefined

        const envStack: {name: string, start: number, end: number}[] = []

        const currentRoot = () => {
            return rootStack[rootStack.length - 1]
        }
        const noRoot = () => {
            return rootStack.length === 0
        }

        this.extension.logger.addLogMessage(`Parsing ${filePath} for outline`)
        let content = fs.readFileSync(filePath, 'utf-8')
        content = content.replace(/([^\\]|^)%.*$/gm, '$1') // Strip comments
        const endPos = content.search(/\\end{document}/gm)
        if (endPos > -1) {
            content = content.substr(0, endPos)
        }

        let pattern = '(?:((?:\\\\(?:input|include|subfile|(?:(?:sub)?import\\*?{([^}]*)}))(?:\\[[^\\[\\]\\{\\}]*\\])?){([^}]*)})|((?:\\\\('
        this.hierarchy.forEach((section, index) => {
            pattern += section
            if (index < this.hierarchy.length - 1) {
                pattern += '|'
            }
        })
        pattern += ')(?:\\*)?(?:\\[[^\\[\\]\\{\\}]*\\])?){(.*)}))'

        // const inputReg = /^((?:\\(?:input|include|subfile)(?:\[[^\[\]\{\}]*\])?){([^}]*)})|^((?:\\((sub)?section)(?:\[[^\[\]\{\}]*\])?){([^}]*)})/gm
        const inputReg = RegExp(pattern, 'm')
        const envReg = /(?:\\(begin|end)(?:\[[^\[\]]*\])?){(?:(figure|table)\*?)}/m

        const lines = content.split('\n')
        for (let lineNumber = 0; lineNumber < lines.length; lineNumber++) {
            const line = lines[lineNumber]
            envReg.lastIndex = 0
            inputReg.lastIndex = 0
            let result = envReg.exec(line)
            if (result && result[1] === 'begin') {
                envStack.push({name: result[2], start: lineNumber, end: lineNumber})
                continue
            } else if (result && result[2] === envStack[envStack.length - 1].name) {
                const env = envStack.pop()
                if (!env) {
                    continue
                }
                env.end = lineNumber
                const caption = this.getCaption(lines, env)
                if (!caption) {
                    continue
                }
                const depth = noRoot() ? 0 : currentRoot().depth + 1
                const newEnv = new Section(`${env.name.charAt(0).toUpperCase() + env.name.slice(1)}: ${caption}`, vscode.TreeItemCollapsibleState.Expanded, depth, env.start, env.end, filePath)
                if (noRoot()) {
                    children.push(newEnv)
                } else {
                    currentRoot().children.push(newEnv)
                }
                continue
            }

            result = inputReg.exec(line)

            // if it's a section elements 5 = section
            // element 6 = title.

            // if it's a subsection:
            // element X = title

            // if it's an input, include, or subfile:
            // element 3 is the file (need to resolve the path)
            // element 0 starts with \input, include, or subfile

            // if it's a subimport
            // element 0 starts with \subimport
            // element 2 is the directory part
            // element 3 is the file
            if (result && result[5] in this.sectionDepths) {
                // is it a section, a subsection, etc?
                const heading = result[5]
                const depth = this.sectionDepths[heading]
                const title = getLongestBalancedString(result[6])

                const newSection = new Section(title, vscode.TreeItemCollapsibleState.Expanded, depth, lineNumber, lineNumber, filePath)
                if (prevSection) {
                    prevSection.toLine = lineNumber - 1
                }
                prevSection = newSection

                // console.log("Created New Section: " + title)
                if (noRoot()) {
                    children.push(newSection)
                    rootStack.push(newSection)
                    continue
                }

                // Find the proper root section
                while (!noRoot() && currentRoot().depth >= depth) {
                    rootStack.pop()
                }
                if (noRoot()) {
                    children.push(newSection)
                } else {
                    currentRoot().children.push(newSection)
                }
                rootStack.push(newSection)

            } else if (imports && result && (result[1].startsWith('\\input') || result[1].startsWith('\\include') || result[1].startsWith('\\subfile') || result[1].startsWith('\\subimport') || result[1].startsWith('\\import') )) {
                // zoom into this file
                // resolve the path
                let inputFilePath
                if (result[1].startsWith('\\subimport')) {
                    inputFilePath = this.extension.manager.resolveFile([path.dirname(filePath)], path.join(result[2], result[3]))
                } else if (result[1].startsWith('\\import')) {
                    inputFilePath = this.extension.manager.resolveFile([result[2]], result[3])
                } else {
                    inputFilePath = this.extension.manager.resolveFile([path.dirname(filePath), this.extension.manager.rootDir], result[3])
                }

                if (!inputFilePath) {
                    this.extension.logger.addLogMessage(`Could not resolve included file ${filePath}`)
                    continue
                }
                if (path.extname(inputFilePath) === '') {
                    inputFilePath += '.tex'
                }
                if (!fs.existsSync(inputFilePath) && fs.existsSync(inputFilePath + '.tex')) {
                    inputFilePath += '.tex'
                }
                if (fs.existsSync(inputFilePath) === false) {
                    this.extension.logger.addLogMessage(`Could not resolve included file ${inputFilePath}`)
                    //console.log(`Could not resolve included file ${inputFilePath}`)
                    continue
                }

                this.buildModel(inputFilePath, rootStack, children)
            }
        }
        return children
    }

    getTreeItem(element: Section) : vscode.TreeItem {

        const hasChildren = element.children.length > 0
        const treeItem: vscode.TreeItem = new vscode.TreeItem(element.label, hasChildren ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None)

        treeItem.command = {
            command: 'latex-workshop.goto-section',
            title: '',
            arguments: [element.fileName, element.lineNumber]
        }

        treeItem.tooltip = `Line ${element.lineNumber + 1} at ${element.fileName}`

        return treeItem
    }

    getChildren(element?: Section) : Thenable<Section[]> {
        if (this.extension.manager.rootFile === undefined) {
            return Promise.resolve([])
        }
        // if the root doesn't exist, we need
        // to explicitly build the model from disk
        if (!element) {
            return Promise.resolve(this.refresh())
        }

        return Promise.resolve(element.children)
    }

    getCaption(lines: string[], env: {name: string, start: number, end: number}) {
        const content = lines.slice(env.start, env.end).join('\n')
        const result = /(?:\\caption(?:\[[^\[\]]*\])?){(.*?)}/gm.exec(content)
        if (result) {
            return result[1][result[1].length - 1] === '.' ? result[1].substr(0, result[1].length - 1) : result[1]
        }
        return undefined
    }
}

export class Section extends vscode.TreeItem {

    public children: Section[] = []

    constructor(
        public readonly label: string,
        public readonly collapsibleState: vscode.TreeItemCollapsibleState,
        public readonly depth: number,
        public readonly lineNumber: number,
        public toLine: number,
        public readonly fileName: string,
        public readonly command?: vscode.Command
    ) {
        super(label, collapsibleState)

    }

    iconPath = {
        light: path.join(__filename, '..', '..', '..', 'resources', 'light', 'Section.svg'),
        dark: path.join(__filename, '..', '..', '..', 'resources', 'dark', 'Section.svg')
    }

    contextValue = 'Section'

}
