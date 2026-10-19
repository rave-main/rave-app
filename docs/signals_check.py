import json, numpy as np
from scipy.stats import spearmanr, rankdata
from sklearn.metrics import roc_auc_score
D='/tmp/claude-0/-home-user/b6da3629-9500-54c7-9b51-607d728d60de/scratchpad/'
meta=json.load(open(D+'panel.json'))
P={k:np.fromfile(D+f'panel_{k}.f32',dtype=np.float32) for k in meta['names']}
week=P['week']; weeks=np.unique(week); first=weeks[int(len(weeks)*0.4)]
# past-only gate: spy vol today above its median over earlier weeks
sv={}
for w in weeks: sv[w]=np.nanmean(P['spyvol20'][week==w])
gate={}; hist=[]
for w in weeks:
    gate[w]=(len(hist)>=26 and sv[w]>np.median(hist)); hist.append(sv[w])
sig={
 'reversal 1wk (-ret5)':-P['ret5'],'reversal 1mo (-ret20)':-P['ret20'],'momentum 12-1':P['mom12_1'],'near 52wk high':P['hi52'],
 'volume surge 5d':P['volsurge5'],'low vol (-vol60)':-P['vol60'],'small size (-ldvol)':-P['ldvol'],
}
g=np.array([gate[w] for w in week])
sig['reversal 1wk, only when market vol high']=np.where(g,-P['ret5'],np.nan)
sig['reversal 1mo, only when market vol high']=np.where(g,-P['ret20'],np.nan)
COST=0.0032
for H in (20,60):
    R=P[f'R{H}']; step=max(1,H//5)
    print(f'\n=== horizon {H} sessions (test weeks only, non-overlapping every {step} weeks) ===')
    print(f"{'signal':44s} {'IC':>7s} {'t(IC)':>6s} {'LS gross':>9s} {'LS net':>8s} {'t(net)':>7s} {'AUC':>6s} {'periods':>7s}")
    tw=[w for w in weeks if w>=first][::step]
    for name,s in sig.items():
        ics=[];ls=[];ys=[];ss=[]
        for w in tw:
            m=(week==w)&np.isfinite(R)&np.isfinite(s)
            if m.sum()<100: continue
            x=s[m]; r=R[m]
            ic=spearmanr(x,r)[0]; ics.append(ic)
            k=max(5,int(0.1*m.sum())); o=np.argsort(x)
            top=r[o[-k:]].clip(-1,3).mean(); bot=r[o[:k]].clip(-1,3).mean()
            ls.append(0.5*(top-bot)-COST-0.5*0.05*H/252)
            rc=r-np.median(r); ys.append((rc>0).astype(int)); ss.append(rankdata(x)/len(x))
        if len(ics)<5: print(name,'too few'); continue
        ic=np.array(ics); l=np.array(ls)
        t_ic=ic.mean()/(ic.std(ddof=1)/np.sqrt(len(ic))); t_ls=l.mean()/(l.std(ddof=1)/np.sqrt(len(l)))
        y=np.concatenate(ys); sc=np.concatenate(ss)
        print(f"{name:44s} {ic.mean():7.3f} {t_ic:6.2f} {np.mean(np.array(ls)+COST+0.5*0.05*H/252):9.2%} {l.mean():8.2%} {t_ls:7.2f} {roc_auc_score(y,sc):6.3f} {len(ic):7d}")
