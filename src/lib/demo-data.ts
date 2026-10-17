import type { ChangeResponse } from "./change";
import type { VehicleResponse } from "./vehicle";

/** 无车辆标识、位置或用户信息的离线占位数据，仅用于首次启动说明。 */
export const DEMO_VEHICLE = {
  request_id: "offline-demo",
  result_code: "success",
  server_time: 0,
  data: {
    status: {
      soc_status: {
        soc: 75,
        charge_state: 0,
        max_soc: 100,
        remaining_range: 300,
        remaining_actual_range: 280,
        sample_time: 0,
        lock_soc: 0,
        charging_power: 0,
        charger_type: 0,
      },
    },
  },
} as unknown as VehicleResponse;

export const DEMO_CHANGE = {
  resultCode: "success",
  resultData: {
    data: [],
    hasMore: false,
    total: 0,
  },
} as unknown as ChangeResponse;
