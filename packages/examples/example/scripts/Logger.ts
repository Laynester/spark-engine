export class Logger {
    private _name: string = "";
    constructor(name: string) {
        this._name = name
    }

    log(message: any) {
        console.log(`[${this._name}] -> `, message)
    }
    warn(message: any) {
        console.warn(`[${this._name}][WARNING] -> `, message)
    }
}