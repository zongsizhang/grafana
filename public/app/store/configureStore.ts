import { createStore, applyMiddleware, compose, combineReducers } from 'redux';
import thunk from 'redux-thunk';
import { createEpicMiddleware, Epic, combineEpics } from 'redux-observable';
// import { createLogger } from 'redux-logger';
import sharedReducers from 'app/core/reducers';
import alertingReducers from 'app/features/alerting/state/reducers';
import teamsReducers from 'app/features/teams/state/reducers';
import apiKeysReducers from 'app/features/api-keys/state/reducers';
import foldersReducers from 'app/features/folders/state/reducers';
import dashboardReducers from 'app/features/dashboard/state/reducers';
import exploreReducers from 'app/features/explore/state/reducers';
import pluginReducers from 'app/features/plugins/state/reducers';
import dataSourcesReducers from 'app/features/datasources/state/reducers';
import usersReducers from 'app/features/users/state/reducers';
import userReducers from 'app/features/profile/state/reducers';
import organizationReducers from 'app/features/org/state/reducers';
import { setStore } from './store';
import { StoreState } from 'app/types/store';
import { ActionOf } from 'app/core/redux/actionCreatorFactory';
import {
  getExploreDataEpic,
  queryTransactionStartEpic,
  processSuccessfulTransactionEpic,
  processFailedTransactionEpic,
} from 'app/features/explore/state/epics';

const rootReducers = {
  ...sharedReducers,
  ...alertingReducers,
  ...teamsReducers,
  ...apiKeysReducers,
  ...foldersReducers,
  ...dashboardReducers,
  ...exploreReducers,
  ...pluginReducers,
  ...dataSourcesReducers,
  ...usersReducers,
  ...userReducers,
  ...organizationReducers,
};

export function addRootReducer(reducers) {
  Object.assign(rootReducers, ...reducers);
}

const rootEpic: Epic = combineEpics(
  getExploreDataEpic,
  queryTransactionStartEpic,
  processSuccessfulTransactionEpic,
  processFailedTransactionEpic
);

export function configureStore() {
  const epicMiddleware = createEpicMiddleware<ActionOf<any>, ActionOf<any>, StoreState>();

  const composeEnhancers = (window as any).__REDUX_DEVTOOLS_EXTENSION_COMPOSE__ || compose;

  const rootReducer = combineReducers(rootReducers);

  const middlewares = process.env.NODE_ENV !== 'production' ? [thunk, epicMiddleware] : [thunk, epicMiddleware];

  setStore(createStore(rootReducer, {}, composeEnhancers(applyMiddleware(...middlewares))));

  epicMiddleware.run(rootEpic);
}
