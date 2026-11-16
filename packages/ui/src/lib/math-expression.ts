/**
 * A function of x written the way a model or a textbook writes it (`2x^2 - sin(x)/x`), compiled
 * to a plain closure. Nothing is ever evaluated as code: this is a small recursive-descent parser
 * over numbers, x, constants, a fixed list of functions, + - * / ^ and implicit multiplication.
 * It may also name parameters (`a sin(x)`), whose values arrive with each call.
 */

export type Vars = Readonly<Record<string, number>>

export type Fn = (x: number, vars?: Vars) => number

const FUNCTIONS: Record<string, (value: number) => number> = {
  asin: Math.asin,
  acos: Math.acos,
  atan: Math.atan,
  sinh: Math.sinh,
  cosh: Math.cosh,
  tanh: Math.tanh,
  sin: Math.sin,
  cos: Math.cos,
  tan: Math.tan,
  sqrt: Math.sqrt,
  cbrt: Math.cbrt,
  abs: Math.abs,
  ln: Math.log,
  log2: Math.log2,
  log: Math.log10,
  exp: Math.exp,
  floor: Math.floor,
  ceil: Math.ceil,
  sign: Math.sign
}

const CONSTANTS: Record<string, number> = { pi: Math.PI, e: Math.E }

const RESERVED = [...Object.keys(FUNCTIONS), ...Object.keys(CONSTANTS), 'x']

/** A parameter is one letter that means nothing else: not x, y (the axes) or e. */
export function isParameterName(name: string): boolean {
  return /^[a-z]$/.test(name) && name !== 'y' && !RESERVED.includes(name)
}

/** Longest names first, so `sinh` is not read as `sin` followed by `h`. */
function namesWith(parameters: readonly string[]): string[] {
  return [...RESERVED, ...parameters.filter(isParameterName)].sort((a, b) => b.length - a.length)
}

type Token =
  { type: 'num'; value: number } | { type: 'name'; value: string } | { type: 'op'; value: string }

function normalize(source: string): string {
  return source
    .replace(/[−–]/g, '-')
    .replace(/[×·⋅]/g, '*')
    .replace(/÷/g, '/')
    .replace(/π/g, 'pi')
    .replace(/²/g, '^2')
    .replace(/³/g, '^3')
    .replace(/√/g, 'sqrt')
    .replace(/\*\*/g, '^')
    .toLowerCase()
}

function tokenize(source: string, names: string[]): Token[] | null {
  const text = normalize(source)
  const tokens: Token[] = []
  let i = 0
  while (i < text.length) {
    const char = text[i]
    if (/\s/.test(char)) {
      i += 1
    } else if (/[0-9.]/.test(char)) {
      const match = /^(\d+\.?\d*|\.\d+)(e[+-]?\d+)?/.exec(text.slice(i))
      if (!match) return null
      tokens.push({ type: 'num', value: Number(match[0]) })
      i += match[0].length
    } else if (/[a-z]/.test(char)) {
      const name = names.find((candidate) => text.startsWith(candidate, i))
      if (!name) return null
      tokens.push({ type: 'name', value: name })
      i += name.length
    } else if ('+-*/^()'.includes(char)) {
      tokens.push({ type: 'op', value: char })
      i += 1
    } else {
      return null
    }
  }
  return tokens
}

class Parser {
  private index = 0
  private readonly tokens: Token[]

  constructor(tokens: Token[]) {
    this.tokens = tokens
  }

  private peek(): Token | undefined {
    return this.tokens[this.index]
  }

  private isOp(value: string): boolean {
    const token = this.peek()
    return token?.type === 'op' && token.value === value
  }

  private expect(value: string): void {
    if (!this.isOp(value)) throw new Error(`Expected ${value}`)
    this.index += 1
  }

  parse(): Fn {
    const fn = this.expression()
    if (this.index !== this.tokens.length) throw new Error('Unexpected input')
    return fn
  }

  private expression(): Fn {
    let left = this.term()
    while (this.isOp('+') || this.isOp('-')) {
      const op = (this.tokens[this.index++] as { value: string }).value
      const a = left
      const b = this.term()
      left = op === '+' ? (x, v) => a(x, v) + b(x, v) : (x, v) => a(x, v) - b(x, v)
    }
    return left
  }

  /** A primary right after a factor multiplies it: `2x`, `3(x+1)`, `x sin(x)`. */
  private startsPrimary(): boolean {
    const token = this.peek()
    return token !== undefined && (token.type !== 'op' || token.value === '(')
  }

  private term(): Fn {
    let left = this.unary()
    for (;;) {
      if (this.isOp('*') || this.isOp('/')) {
        const op = (this.tokens[this.index++] as { value: string }).value
        const a = left
        const b = this.unary()
        left = op === '*' ? (x, v) => a(x, v) * b(x, v) : (x, v) => a(x, v) / b(x, v)
      } else if (this.startsPrimary()) {
        const a = left
        const b = this.power()
        left = (x, v) => a(x, v) * b(x, v)
      } else {
        return left
      }
    }
  }

  /** `-x^2` is `-(x^2)`, as in mathematics. */
  private unary(): Fn {
    if (this.isOp('-')) {
      this.index += 1
      const inner = this.unary()
      return (x, v) => -inner(x, v)
    }
    if (this.isOp('+')) {
      this.index += 1
      return this.unary()
    }
    return this.power()
  }

  private power(): Fn {
    const base = this.primary()
    if (!this.isOp('^')) return base
    this.index += 1
    const exponent = this.unary()
    return (x, v) => Math.pow(base(x, v), exponent(x, v))
  }

  private primary(): Fn {
    const token = this.peek()
    if (!token) throw new Error('Unexpected end')
    this.index += 1
    if (token.type === 'num') {
      const value = token.value
      return () => value
    }
    if (token.type === 'op') {
      if (token.value !== '(') throw new Error(`Unexpected ${token.value}`)
      const inner = this.expression()
      this.expect(')')
      return inner
    }
    if (token.value === 'x') return (x) => x
    if (token.value in CONSTANTS) {
      const value = CONSTANTS[token.value]
      return () => value
    }
    if (!(token.value in FUNCTIONS)) {
      const name = token.value
      return (_x, v) => v?.[name] ?? NaN
    }
    const fn = FUNCTIONS[token.value]
    // `sin^2(x)` is how squares of functions are written.
    let exponent: Fn | null = null
    if (this.isOp('^')) {
      this.index += 1
      exponent = this.primary()
    }
    // `sin x` and `sin(x)` alike; without parentheses the argument is one power.
    const argument = this.isOp('(') ? this.primary() : this.power()
    if (!exponent) return (x, v) => fn(argument(x, v))
    const power = exponent
    return (x, v) => Math.pow(fn(argument(x, v)), power(x, v))
  }
}

/**
 * The function `source` describes, or null when it is not one this can read. `parameters` are
 * the one-letter names it may use besides x; a call without a value for one gives NaN.
 */
export function compileExpression(source: string, parameters: readonly string[] = []): Fn | null {
  const tokens = tokenize(source, namesWith(parameters))
  if (!tokens || tokens.length === 0) return null
  try {
    return new Parser(tokens).parse()
  } catch {
    return null
  }
}
