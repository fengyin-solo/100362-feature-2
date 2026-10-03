import { defineStore } from 'pinia'

// 可切换的林场身份：用于演示「接收后跨林场人员只能查看」。
export const FOREST_FARMS = ['青松岭林场', '白桦坪林场'] as const

export const useSessionStore = defineStore('session', {
  state: () => ({
    operator: '值班管理员',
    shiftLabel: '白班 08:00-20:00',
    scope: '森林防火巡护管理系统',
    forestFarm: '青松岭林场' as string,
  }),
  getters: {
    canOperate: (state) => state.operator.length > 0,
  },
  actions: {
    setShift(label: string) {
      this.shiftLabel = label
    },
    setForestFarm(farm: string) {
      this.forestFarm = farm
    },
  },
})
