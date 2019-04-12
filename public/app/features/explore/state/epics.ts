// @ts-ignore
import _ from 'lodash';
import { map, tap, mergeMap, filter, catchError, single, takeWhile } from 'rxjs/operators';
import { from, merge, interval } from 'rxjs';
import { Epic, ofType } from 'redux-observable';
import { actionCreatorFactory, ActionOf } from 'app/core/redux';
import { DataQuery, QueryHint } from '@grafana/ui/src/types/datasource';

import { ExploreId, ResultType, QueryOptions, ExploreItemState, QueryTransaction } from 'app/types/explore';
import { buildQueryTransaction, makeTimeSeriesList, updateHistory } from 'app/core/utils/explore';
import {
  queryTransactionStartAction,
  queryTransactionSuccessAction,
  scanRangeAction,
  scanStopAction,
  queryTransactionFailureAction,
} from './actionTypes';
import { StoreState } from 'app/types';

export interface GetExploreDataPayload {
  exploreId: ExploreId;
  resultType: ResultType;
  queryOptions: QueryOptions;
  resultGetter?: Function;
}

export const getExploreDataAction = actionCreatorFactory<GetExploreDataPayload>('explore/getExploreData').create();

export interface GetQueryResultPayload {
  exploreId: ExploreId;
  resultType: ResultType;
  rowIndex: number;
  transaction: QueryTransaction;
}

export const getQueryResultAction = actionCreatorFactory<GetQueryResultPayload>('explore/getQueryResult').create();

export interface ProcessSuccessfulTransactionPayload {
  exploreId: ExploreId;
  transactionId: string;
  result: any;
  latency: number;
  queries: DataQuery[];
  datasourceId: string;
}

export const processSuccessfulTransactionAction = actionCreatorFactory<ProcessSuccessfulTransactionPayload>(
  'explore/processSuccessfulTransaction'
).create();

export interface ProcessFailedTransactionPayload {
  exploreId: ExploreId;
  transactionId: string;
  response: any;
  datasourceId: string;
}

export const processFailedTransactionAction = actionCreatorFactory<ProcessFailedTransactionPayload>(
  'explore/processFailedTransactionAction'
).create();

export const getExploreDataEpic: Epic<ActionOf<any>, ActionOf<any>, StoreState> = (action$, state$) =>
  action$.pipe(
    ofType(getExploreDataAction.type),
    map(action => {
      const { exploreId, resultType, queryOptions } = action.payload;
      const { queries, queryIntervals, range, scanning, streaming }: Partial<ExploreItemState> = state$.value.explore[
        exploreId
      ];

      const actions = queries.map((query, rowIndex) => {
        const transaction = buildQueryTransaction(
          query,
          rowIndex,
          resultType,
          queryOptions,
          range,
          queryIntervals,
          scanning,
          streaming
        );

        return getQueryResultAction({
          exploreId,
          resultType,
          rowIndex,
          transaction,
        });
      });

      return actions;
    }),
    mergeMap(action => action)
  );

export const getQueryResultEpic: Epic<ActionOf<any>, ActionOf<any>, StoreState> = (action$, state$) => {
  return action$.pipe(
    ofType(getQueryResultAction.type),
    map(action => {
      const { exploreId, resultType, transaction, rowIndex } = action.payload;
      const {
        datasourceInstance,
        eventBridge,
        queryTransactions,
        queries,
        streaming,
      }: Partial<ExploreItemState> = state$.value.explore[exploreId];
      const datasourceId = datasourceInstance.meta.id;
      const now = Date.now();
      const resultGetter =
        resultType === 'Graph' ? makeTimeSeriesList : resultType === 'Table' ? (data: any) => data[0] : null;

      const startStream$ = from([
        queryTransactionStartAction({
          exploreId,
          resultType,
          rowIndex,
          transaction,
        }),
      ]);

      const intervalStream$ = interval(1000).pipe(tap(value => console.log(exploreId + ': ' + value)));

      const getQueryStream = (transaction: QueryTransaction, queryTransactions: QueryTransaction[]) =>
        from(datasourceInstance.query({ ...transaction.options, streaming })).pipe(
          map(result => result.data || []),
          tap((data: any) => eventBridge.emit('data-received', data)),
          map(data => (resultGetter ? resultGetter(data, transaction, queryTransactions) : data)),
          map(result =>
            processSuccessfulTransactionAction({
              exploreId,
              transactionId: transaction.id,
              result,
              latency: Date.now() - now,
              queries,
              datasourceId,
            })
          ),
          single(),
          catchError(response => {
            eventBridge.emit('data-error', response);
            return [
              processFailedTransactionAction({
                exploreId,
                transactionId: transaction.id,
                response,
                datasourceId,
              }),
            ];
          })
        );

      const liveStream$ = intervalStream$.pipe(
        map(() => getQueryStream(transaction, queryTransactions)),
        mergeMap(stream => stream),
        takeWhile(action => {
          const queryTransactions: QueryTransaction[] = state$.value.explore[exploreId].queryTransactions;
          const transaction = queryTransactions.filter(qt => qt.id === action.payload.transactionId)[0];
          return streaming && transaction && transaction.streaming;
        })
      );

      const resultStream$ =
        streaming && transaction.streaming
          ? merge(startStream$, liveStream$)
          : merge(startStream$, getQueryStream(transaction, queryTransactions));

      return resultStream$;
    }),
    mergeMap(actions => actions)
  );
};

export const processSuccessfulTransactionEpic: Epic<ActionOf<any>, ActionOf<any>, StoreState> = (action$, state$) =>
  action$.pipe(
    ofType(processSuccessfulTransactionAction.type),
    map(action => {
      const { exploreId, transactionId, result, latency, queries, datasourceId } = action.payload;
      const {
        datasourceInstance,
        history,
        queryTransactions,
        scanner,
        scanning,
      }: Partial<ExploreItemState> = state$.value.explore[exploreId];

      // If datasource already changed, results do not matter
      if (datasourceInstance.meta.id !== datasourceId) {
        return null;
      }

      // Transaction might have been discarded
      const transaction = queryTransactions.find(qt => qt.id === transactionId);
      if (!transaction) {
        return null;
      }

      // Get query hints
      let hints: QueryHint[];
      if (datasourceInstance.getQueryHints) {
        hints = datasourceInstance.getQueryHints(transaction.query, result);
      }

      // Mark transactions as complete and attach result
      const nextQueryTransactions = queryTransactions.map(qt => {
        if (qt.id === transactionId) {
          return {
            ...qt,
            hints,
            latency,
            result,
            done: true,
          };
        }
        return qt;
      });

      // Side-effect: Saving history in localstorage
      const nextHistory = updateHistory(history, datasourceId, queries);
      const actions: Array<ActionOf<any>> = [
        queryTransactionSuccessAction({
          exploreId,
          history: nextHistory,
          queryTransactions: nextQueryTransactions,
        }),
      ];

      // Keep scanning for results if this was the last scanning transaction
      if (scanning) {
        if (_.size(result) === 0) {
          const other = nextQueryTransactions.find(qt => qt.scanning && !qt.done);
          if (!other) {
            const range = scanner();
            actions.push(scanRangeAction({ exploreId, range }));
          }
        } else {
          // We can stop scanning if we have a result
          actions.push(scanStopAction({ exploreId }));
        }
      }

      return actions;
    }),
    filter(action => action !== null),
    mergeMap(actions => actions)
  );

export const processFailedTransactionEpic: Epic<ActionOf<any>, ActionOf<any>, StoreState> = (action$, state$) =>
  action$.pipe(
    ofType(processFailedTransactionAction.type),
    map(action => {
      const { exploreId, transactionId, response, datasourceId } = action.payload;
      const { datasourceInstance, queryTransactions }: Partial<ExploreItemState> = state$.value.explore[exploreId];

      if (response.cancelled) {
        const nextQueryTransactions = queryTransactions.map(qt => {
          if (qt.id === transactionId) {
            return {
              ...qt,
              done: true,
            };
          }
          return qt;
        });
        return queryTransactionFailureAction({ exploreId, queryTransactions: nextQueryTransactions });
      }

      if (datasourceInstance.meta.id !== datasourceId) {
        // Navigated away, queries did not matter
        return null;
      }

      // Transaction might have been discarded
      if (!queryTransactions.find(qt => qt.id === transactionId)) {
        return null;
      }

      console.error(response);

      let error: string;
      let errorDetails: string;
      if (response.data) {
        if (typeof response.data === 'string') {
          error = response.data;
        } else if (response.data.error) {
          error = response.data.error;
          if (response.data.response) {
            errorDetails = response.data.response;
          }
        } else {
          throw new Error('Could not handle error response');
        }
      } else if (response.message) {
        error = response.message;
      } else if (typeof response === 'string') {
        error = response;
      } else {
        error = 'Unknown error during query transaction. Please check JS console logs.';
      }

      // Mark transactions as complete
      const nextQueryTransactions = queryTransactions.map(qt => {
        if (qt.id === transactionId) {
          return {
            ...qt,
            error,
            errorDetails,
            done: true,
          };
        }
        return qt;
      });

      return queryTransactionFailureAction({ exploreId, queryTransactions: nextQueryTransactions });
    }),
    filter(action => action !== null)
  );
