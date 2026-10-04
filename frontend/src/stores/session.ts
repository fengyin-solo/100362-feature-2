import { defineStore } from 'pinia'

// 演示用林场：当前操作员所属林场，决定跨林场记录是可操作还是只读。
export const FOREST_FARMS = ['青山林场', '云岭林场']

export const useSessionStore = defineStore('session', {
  state: () => ({
    operator: '值班管理员',
    shiftLabel: '白班 08:00-20:00',
    scope: '森林防火巡护管理系统',
    forestFarm: FOREST_FARMS[0],
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
