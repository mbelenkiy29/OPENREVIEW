"use client";
import {useActionState} from 'react';import {syncPullCatalog,requestCatalogReview} from './actions';import {Icon} from '../ui/icons';
export function CatalogSync({repositoryId,disabled}:{repositoryId:string;disabled?:boolean}){
 const [state,action,pending]=useActionState(syncPullCatalog,{});
 return <form className="catalog-sync" action={action}><input type="hidden" name="repositoryId" value={repositoryId}/><button disabled={disabled||pending}><Icon name="arrowsClockwise"/>{pending?'Starting import…':'Sync open pull requests'}</button>{state.error&&<p role="alert">{state.error}</p>}{state.saved&&<p role="status">Import requested. Progress updates automatically.</p>}</form>;
}

// `compact`: the list row's short "Review" button; its accessible name still says what it does.
export function CatalogReview({repositoryId,prNumber,revision,baseRevision,compact}:{repositoryId:string;prNumber:number;revision:string;baseRevision:string;compact?:boolean}){
 const [state,action,pending]=useActionState(requestCatalogReview,{});
 return <form className="catalog-review" action={action}><input type="hidden" name="repositoryId" value={repositoryId}/><input type="hidden" name="prNumber" value={prNumber}/><input type="hidden" name="expectedRevision" value={revision}/><input type="hidden" name="expectedBaseRevision" value={baseRevision}/><button className={compact?'text-action':undefined} aria-label={'Review current revision for #'+prNumber} disabled={pending}>{compact?<><Icon name={pending?'circleNotch':'arrowsClockwise'}/>{pending?'Starting…':'Review'}</>:pending?'Starting review…':'Review current revision'}</button>{state.error&&<p role="alert">{state.error}</p>}</form>;
}
