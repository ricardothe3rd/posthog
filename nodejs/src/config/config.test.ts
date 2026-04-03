import { buildIntegerMatcherWithPercentage } from './config'

describe('buildIntegerMatcherWithPercentage', () => {
    it('should return false for empty config', () => {
        const matcher = buildIntegerMatcherWithPercentage('')
        expect(matcher(123)).toBe(false)
    })

    it('should return false for undefined config', () => {
        const matcher = buildIntegerMatcherWithPercentage(undefined)
        expect(matcher(123)).toBe(false)
    })

    it('should match all with *', () => {
        const matcher = buildIntegerMatcherWithPercentage('*')
        expect(matcher(123)).toBe(true)
        expect(matcher(456)).toBe(true)
    })

    it('should match specific IDs', () => {
        const matcher = buildIntegerMatcherWithPercentage('123,456')
        expect(matcher(123)).toBe(true)
        expect(matcher(456)).toBe(true)
        expect(matcher(789)).toBe(false)
    })

    it('should support percentage rollout for all traffic', () => {
        const matcherAll = buildIntegerMatcherWithPercentage('*:1.0')
        expect(matcherAll(123)).toBe(true)

        const matcherNone = buildIntegerMatcherWithPercentage('*:0')
        expect(matcherNone(123)).toBe(false)
    })

    it('should support specific IDs combined with percentage', () => {
        const matcher = buildIntegerMatcherWithPercentage('123,*:0')
        expect(matcher(123)).toBe(true)
        expect(matcher(456)).toBe(false)
    })
})
