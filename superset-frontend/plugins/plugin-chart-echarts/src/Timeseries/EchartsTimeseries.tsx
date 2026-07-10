/**
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  DTTM_ALIAS,
  BinaryQueryObjectFilterClause,
  AxisType,
  getTimeFormatter,
  getColumnLabel,
  getNumberFormatter,
  LegendState,
  ensureIsArray,
} from '@superset-ui/core';
import type { ViewRootGroup } from 'echarts/types/src/util/types';
import type GlobalModel from 'echarts/types/src/model/Global';
import type ComponentModel from 'echarts/types/src/model/Component';
import { regression as ecStatRegression } from 'echarts-stat';
import { EchartsHandler, EventHandlers } from '../types';
import Echart from '../components/Echart';
import { RegressionConfig, TimeseriesChartTransformedProps } from './types';
import { formatSeriesName } from '../utils/series';
import { ExtraControls } from '../components/ExtraControls';

const TIMER_DURATION = 300;
// Trailing debounce used as a fallback to settle mouse-wheel zoom, which has no
// explicit "release" event like the slider handle does.
const REGRESSION_DEBOUNCE_DURATION = 300;

export default function EchartsTimeseries({
  formData,
  height,
  width,
  echartOptions,
  groupby,
  labelMap,
  selectedValues,
  setDataMask,
  setControlValue,
  legendData = [],
  onContextMenu,
  onLegendStateChanged,
  onFocusedSeries,
  xValueFormatter,
  xAxis,
  refs,
  emitCrossFilters,
  coltypeMapping,
  onLegendScroll,
  regressionConfig,
}: TimeseriesChartTransformedProps) {
  const { stack } = formData;
  const echartRef = useRef<EchartsHandler | null>(null);
  // eslint-disable-next-line no-param-reassign
  refs.echartRef = echartRef;
  const clickTimer = useRef<ReturnType<typeof setTimeout>>();
  // Tracks whether a data zoom has occurred that hasn't yet been reflected in
  // the regression line, plus the trailing debounce timer for mouse-wheel zoom.
  const regressionDirty = useRef(false);
  const regressionDebounce = useRef<ReturnType<typeof setTimeout>>();
  const extraControlRef = useRef<HTMLDivElement>(null);
  const [extraControlHeight, setExtraControlHeight] = useState(0);
  useEffect(
    () => () => {
      if (regressionDebounce.current) {
        clearTimeout(regressionDebounce.current);
      }
    },
    [],
  );
  useEffect(() => {
    const element = extraControlRef.current;
    if (!element) {
      setExtraControlHeight(0);
      return undefined;
    }

    const updateHeight = () => {
      setExtraControlHeight(element.offsetHeight || 0);
    };

    updateHeight();

    if (typeof ResizeObserver === 'function') {
      const resizeObserver = new ResizeObserver(() => {
        updateHeight();
      });
      resizeObserver.observe(element);
      return () => {
        resizeObserver.disconnect();
      };
    }

    window.addEventListener('resize', updateHeight);
    return () => {
      window.removeEventListener('resize', updateHeight);
    };
  }, [formData.showExtraControls]);

  const hasDimensions = ensureIsArray(groupby).length > 0;

  const getModelInfo = (target: ViewRootGroup, globalModel: GlobalModel) => {
    let el = target;
    let model: ComponentModel | null = null;
    while (el) {
      // eslint-disable-next-line no-underscore-dangle
      const modelInfo = el.__ecComponentInfo;
      if (modelInfo != null) {
        model = globalModel.getComponent(modelInfo.mainType, modelInfo.index);
        break;
      }
      el = el.parent;
    }
    return model;
  };

  const getCrossFilterDataMask = useCallback(
    (value: string) => {
      const selected: string[] = Object.values(selectedValues);
      let values: string[];
      if (selected.includes(value)) {
        values = selected.filter(v => v !== value);
      } else {
        values = [value];
      }
      const groupbyValues = values.map(value => labelMap[value]);
      return {
        dataMask: {
          extraFormData: {
            filters:
              values.length === 0
                ? []
                : groupby.map((col, idx) => {
                    const val = groupbyValues.map(v => v[idx]);
                    if (val === null || val === undefined)
                      return {
                        col,
                        op: 'IS NULL' as const,
                      };
                    return {
                      col,
                      op: 'IN' as const,
                      val: val as (string | number | boolean)[],
                    };
                  }),
          },
          filterState: {
            label: groupbyValues.length ? groupbyValues : undefined,
            value: groupbyValues.length ? groupbyValues : null,
            selectedValues: values.length ? values : null,
          },
        },
        isCurrentValueSelected: selected.includes(value),
      };
    },
    [groupby, labelMap, selectedValues],
  );

  const handleChange = useCallback(
    (value: string) => {
      if (!emitCrossFilters) {
        return;
      }
      setDataMask(getCrossFilterDataMask(value).dataMask);
    },
    [emitCrossFilters, setDataMask, getCrossFilterDataMask],
  );

  // Recalculates the regression line (via echarts-stat) using only the points
  // currently visible within the axis extents. Triggered on Data Zoom so the
  // fit reflects the visible portion of the chart.
  const recalculateRegression = useCallback(() => {
    const config: RegressionConfig | undefined = regressionConfig;
    const echartInstance = echartRef.current?.getEchartInstance();
    if (!config || !echartInstance) {
      return;
    }
    // The regression's x dimension maps to the yAxis when the chart is
    // horizontally oriented, otherwise to the xAxis.
    const axisMainType = config.isHorizontal ? 'yAxis' : 'xAxis';
    let extent: number[] | undefined;
    try {
      // @ts-ignore - accessing internal model to read the current axis extent
      const axisModel = echartInstance.getModel().getComponent(axisMainType, 0);
      // @ts-ignore
      extent = axisModel?.axis?.scale?.getExtent?.();
    } catch (e) {
      extent = undefined;
    }

    const [min, max] =
      Array.isArray(extent) && extent.length === 2
        ? extent
        : [-Infinity, Infinity];

    const visibleSource = config.source.filter(([x]) => x >= min && x <= max);

    // Need at least two points to fit a line.
    const points =
      visibleSource.length > 1
        ? (ecStatRegression(config.method, visibleSource, config.order)
            .points as number[][])
        : [];

    const data = config.isHorizontal ? points.map(([x, y]) => [y, x]) : points;

    echartInstance.setOption({
      series: [
        {
          name: config.seriesName,
          // switch from the dataset transform to explicit data so the line
          // reflects only the visible range
          datasetIndex: undefined,
          data,
        },
      ],
    });
  }, [regressionConfig]);

  // Recalculates the regression only if a zoom happened since the last flush.
  // Called when the zoom interaction settles (slider release / drag end / the
  // trailing debounce for mouse-wheel zoom).
  const flushRegression = useCallback(() => {
    if (!regressionDirty.current) {
      return;
    }
    regressionDirty.current = false;
    if (regressionDebounce.current) {
      clearTimeout(regressionDebounce.current);
      regressionDebounce.current = undefined;
    }
    recalculateRegression();
  }, [recalculateRegression]);

  // Recalculate the regression when the pointer is released anywhere, not just
  // over the chart canvas. When dragging the zoom slider handle, the release
  // often happens outside zrender's canvas, so a zrender 'mouseup' is missed and
  // the handle appears stuck to the cursor. A document-level listener always
  // fires, letting the handle drop and settling the regression.
  useEffect(() => {
    const handlePointerUp = () => {
      flushRegression();
    };
    document.addEventListener('mouseup', handlePointerUp);
    document.addEventListener('touchend', handlePointerUp);
    return () => {
      document.removeEventListener('mouseup', handlePointerUp);
      document.removeEventListener('touchend', handlePointerUp);
    };
  }, [flushRegression]);

  const eventHandlers: EventHandlers = {
    click: props => {
      if (!hasDimensions) {
        return;
      }
      if (clickTimer.current) {
        clearTimeout(clickTimer.current);
      }
      // Ensure that double-click events do not trigger single click event. So we put it in the timer.
      clickTimer.current = setTimeout(() => {
        const { seriesName: name } = props;
        handleChange(name);
      }, TIMER_DURATION);
    },
    mouseout: () => {
      onFocusedSeries(null);
    },
    mouseover: params => {
      onFocusedSeries(params.seriesName);
    },
    datazoom: () => {
      // The datazoom event fires continuously while the slider handle is being
      // dragged. Instead of recalculating on every tick, mark the regression as
      // dirty and recompute only when the interaction settles (see the mouseup
      // handler and the trailing debounce below for mouse-wheel zoom).
      regressionDirty.current = true;
      if (regressionDebounce.current) {
        clearTimeout(regressionDebounce.current);
      }
      regressionDebounce.current = setTimeout(() => {
        flushRegression();
      }, REGRESSION_DEBOUNCE_DURATION);
    },
    legendscroll: payload => {
      onLegendScroll?.(payload.scrollDataIndex);
    },
    legendselectchanged: payload => {
      onLegendStateChanged?.(payload.selected);
    },
    legendselectall: payload => {
      onLegendStateChanged?.(payload.selected);
    },
    legendinverseselect: payload => {
      onLegendStateChanged?.(payload.selected);
    },
    contextmenu: async eventParams => {
      if (onContextMenu) {
        eventParams.event.stop();
        const { data, seriesName } = eventParams;
        const drillToDetailFilters: BinaryQueryObjectFilterClause[] = [];
        const drillByFilters: BinaryQueryObjectFilterClause[] = [];
        const pointerEvent = eventParams.event.event;
        const values = [
          ...(eventParams.name ? [eventParams.name] : []),
          ...(labelMap[seriesName] ?? []),
        ];
        const groupBy = ensureIsArray(formData.groupby);
        if (data && xAxis.type === AxisType.Time) {
          drillToDetailFilters.push({
            col:
              // if the xAxis is '__timestamp', granularity_sqla will be the column of filter
              xAxis.label === DTTM_ALIAS
                ? formData.granularitySqla
                : xAxis.label,
            grain: formData.timeGrainSqla,
            op: '==',
            val: data[0],
            formattedVal: xValueFormatter(data[0]),
          });
        }
        [
          ...(xAxis.type === AxisType.Category && data ? [xAxis.label] : []),
          ...groupBy,
        ].forEach((dimension, i) =>
          drillToDetailFilters.push({
            col: dimension,
            op: '==',
            val: values[i],
            formattedVal: String(values[i]),
          }),
        );
        groupBy.forEach((dimension, i) => {
          const dimensionValues = labelMap[seriesName] ?? [];

          // Skip the metric values at the beginning and get the actual dimension value
          // If we have multiple metrics, they come first, then the dimension values
          const metricsCount = dimensionValues.length - groupBy.length;
          const val = dimensionValues[metricsCount + i];

          drillByFilters.push({
            col: dimension,
            op: '==',
            val,
            formattedVal: formatSeriesName(val, {
              timeFormatter: getTimeFormatter(formData.dateFormat),
              numberFormatter: getNumberFormatter(formData.numberFormat),
              coltype: coltypeMapping?.[getColumnLabel(dimension)],
            }),
          });
        });

        onContextMenu(pointerEvent.clientX, pointerEvent.clientY, {
          drillToDetail: drillToDetailFilters,
          drillBy: { filters: drillByFilters, groupbyFieldName: 'groupby' },
          crossFilter: hasDimensions
            ? getCrossFilterDataMask(seriesName)
            : undefined,
        });
      }
    },
  };

  const zrEventHandlers: EventHandlers = {
    dblclick: params => {
      // clear single click timer
      if (clickTimer.current) {
        clearTimeout(clickTimer.current);
      }
      const pointInPixel = [params.offsetX, params.offsetY];
      const echartInstance = echartRef.current?.getEchartInstance();
      if (echartInstance?.containPixel('grid', pointInPixel)) {
        // do not trigger if click unstacked chart's blank area
        if (!stack && params.target?.type === 'ec-polygon') return;
        // @ts-ignore
        const globalModel = echartInstance.getModel();
        const model = getModelInfo(params.target, globalModel);
        if (model) {
          const { name } = model;
          const legendState: LegendState = legendData.reduce(
            (previous, datum) => ({
              ...previous,
              [datum]: datum === name,
            }),
            {},
          );
          onLegendStateChanged?.(legendState);
        }
      }
    },
  };

  return (
    <>
      <div ref={extraControlRef}>
        <ExtraControls formData={formData} setControlValue={setControlValue} />
      </div>
      <Echart
        ref={echartRef}
        refs={refs}
        height={height - extraControlHeight}
        width={width}
        echartOptions={echartOptions}
        eventHandlers={eventHandlers}
        zrEventHandlers={zrEventHandlers}
        selectedValues={selectedValues}
      />
    </>
  );
}
